import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CanonicalConversation,
  CanonicalThread,
  ConversationReplacePreview,
  ReplaceItemResult,
  ReplaceRunResult,
  ReplaceSelection,
  TargetPaths,
} from "../../core/types.js";
import { isTerminalTurn } from "../../core/types.js";
import { checkpointForThread, type NativeProjectionIdentityV1 } from "../../core/checkpoint.js";
import { canonicalPath, deterministicUuid, sha256 } from "../../core/util.js";
import { safetyError, writeError } from "../../core/errors.js";
import { listImportsForTargets, recordConsolidation, type LedgerRecord, type StoredLedgerRecord } from "../ledger.js";
import {
  callV2Native,
  createBackup,
  materializeAssets,
  planV2Thread,
  type V2ThreadReply,
  IMPORTER_VERSION,
  type V2Plan,
} from "../importer.js";
import { nativeProjectionIdentityMatches, projectedHistoryMatches } from "./history.js";
import { reconcileNativeHistory, nativeExpectedTurnEvents } from "./native-history.js";
import { verifyOrRecoverV2Assets } from "./assets.js";
import { verifyUpgradedPrefix } from "./upgraded-binding.js";

type NativeThread = {
  threadId: string;
  exists: boolean;
  thread?: Record<string, any>;
  records?: Record<string, any>;
  snapshot?: { projection?: { thread?: Record<string, any>; providerThreads?: Array<Record<string, any>> } };
  events?: Array<{ id: string; sequence: number }>;
};

type ReplacementPlan = {
  conversation: CanonicalConversation;
  thread: CanonicalThread;
  oldRecord?: StoredLedgerRecord;
  oldRecords: StoredLedgerRecord[];
  planned?: V2Plan;
  oldThreads?: NativeThread[];
  upgradedPrefix?: { plan: V2Plan; expectedSnapshot: Record<string, unknown>; event?: Record<string, unknown>; attach: boolean };
  replacementId?: string;
  recoverLedger?: boolean;
  recoverySequences?: Array<{ eventId: string; threadId: string; sequence: number }>;
  result: ReplaceItemResult;
};

const targetHash = (paths: TargetPaths) => sha256(canonicalPath(paths.dbPath));

function knownLedgerTargetIds(paths: TargetPaths): { current: string; all: string[] } {
  const current = targetHash(paths);
  const all = [current];
  if (basename(paths.dbPath) === "statev2.sqlite") {
    all.push(sha256(canonicalPath(join(paths.stateDir, "state.sqlite"))));
  }
  return { current, all: [...new Set(all)] };
}

function replacementLedgerRows(paths: TargetPaths, source: string): StoredLedgerRecord[] {
  const { current, all } = knownLedgerTargetIds(paths);
  const byThread = new Map<string, StoredLedgerRecord>();
  for (const row of listImportsForTargets(all, source)
    .sort((left, right) => Number(right.targetId === current) - Number(left.targetId === current))) {
    if (!byThread.has(row.threadId)) byThread.set(row.threadId, row);
  }
  return [...byThread.values()];
}

type ReplacementReceipt = {
  version: 1;
  targetId: string;
  oldThreadIds: string[];
  oldShellHashes: Record<string, string>;
  replacementThreadId: string;
  backupPath: string;
  backupSha256: string;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

function replacementReceiptPath(paths: TargetPaths, plan: ReplacementPlan): string {
  const identity = JSON.stringify({ targetId: targetHash(paths), oldThreadIds: plan.oldRecords.map((record) => record.threadId), replacementThreadId: plan.planned!.threadId });
  return join(paths.stateDir, "t3-import-backups", `replacement-${sha256(identity)}.json`);
}

function receiptShellHashes(plan: ReplacementPlan): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const record of plan.oldRecords) {
    const shell = projectedThread(plan.oldThreads?.find((value) => value.threadId === record.threadId));
    if (!shell) throw safetyError("The native helper did not return every old task shell needed for the replacement backup receipt.");
    hashes[record.threadId] = sha256(stableJson(shell));
  }
  return hashes;
}

async function verifyReceiptBackup(paths: TargetPaths, receipt: ReplacementReceipt): Promise<void> {
  const backupDirectory = resolve(paths.stateDir, "t3-import-backups");
  const backupPath = resolve(receipt.backupPath);
  const relativeBackup = relative(backupDirectory, backupPath);
  if (!relativeBackup || relativeBackup === ".." || relativeBackup.startsWith(`..${sep}`) || isAbsolute(relativeBackup)) {
    throw safetyError("The replacement backup receipt points outside the target backup directory.");
  }
  const file = lstatSync(backupPath);
  if (!file.isFile() || file.isSymbolicLink() || sha256(readFileSync(backupPath)) !== receipt.backupSha256) {
    throw safetyError("The replacement backup receipt no longer matches its verified backup file.");
  }
  const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    if (String(backupDb.pragma("integrity_check", { simple: true })) !== "ok") {
      throw safetyError("The replacement backup receipt points to a backup that failed its integrity check.");
    }
  } finally { backupDb.close(); }
  const readback = await inspect({ ...paths, dbPath: backupPath }, [...receipt.oldThreadIds, receipt.replacementThreadId]);
  if (!readback.ok || readback.integrity !== "ok") throw safetyError("The replacement backup could not be inspected with the pinned native helper.");
  const threads = new Map((readback.threads ?? []).map((value) => [value.threadId, value as NativeThread]));
  if (threads.get(receipt.replacementThreadId)?.exists !== false) throw safetyError("The replacement backup already contains the deterministic new task; it is not a pre-mutation snapshot.");
  for (const threadId of receipt.oldThreadIds) {
    const value = threads.get(threadId);
    const shell = projectedThread(value);
    if (!value?.exists || !shell || sha256(stableJson(shell)) !== receipt.oldShellHashes[threadId]) {
      throw safetyError("The replacement backup does not contain the exact pre-mutation task shell recorded in its receipt.");
    }
  }
}

async function readReplacementReceipt(paths: TargetPaths, plan: ReplacementPlan): Promise<ReplacementReceipt | undefined> {
  const path = replacementReceiptPath(paths, plan);
  try { lstatSync(path); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  let receipt: ReplacementReceipt;
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) {
      throw new Error("receipt is not a private regular file");
    }
    receipt = JSON.parse(readFileSync(path, "utf8")) as ReplacementReceipt;
  } catch (error) {
    throw safetyError(`The replacement recovery receipt cannot be read safely (${error instanceof Error ? error.message : String(error)}).`);
  }
  const expectedIds = plan.oldRecords.map((record) => record.threadId);
  if (receipt.version !== 1 || receipt.targetId !== targetHash(paths) || receipt.replacementThreadId !== plan.planned!.threadId
    || stableJson(receipt.oldThreadIds) !== stableJson(expectedIds)
    || !receipt.oldShellHashes || stableJson(Object.keys(receipt.oldShellHashes).sort()) !== stableJson([...expectedIds].sort())
    || typeof receipt.backupPath !== "string" || typeof receipt.backupSha256 !== "string") {
    throw safetyError("The replacement recovery receipt does not belong to this exact target/task replacement.");
  }
  await verifyReceiptBackup(paths, receipt);
  return receipt;
}

async function writeReplacementReceipt(paths: TargetPaths, plan: ReplacementPlan, backupPath: string): Promise<ReplacementReceipt> {
  const receipt: ReplacementReceipt = {
    version: 1, targetId: targetHash(paths), oldThreadIds: plan.oldRecords.map((record) => record.threadId),
    oldShellHashes: receiptShellHashes(plan), replacementThreadId: plan.planned!.threadId,
    backupPath, backupSha256: sha256(readFileSync(backupPath)),
  };
  await verifyReceiptBackup(paths, receipt);
  const destination = replacementReceiptPath(paths, plan);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(receipt));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
    const directory = openSync(join(paths.stateDir, "t3-import-backups"), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw writeError(`Could not persist the replacement recovery receipt: ${error instanceof Error ? error.message : String(error)}`, error);
  }
  const info = lstatSync(destination);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw safetyError("The replacement recovery receipt permissions are not private.");
  return receipt;
}

function removeReplacementReceipt(paths: TargetPaths, plan: ReplacementPlan): void {
  rmSync(replacementReceiptPath(paths, plan), { force: true });
}

export function replacementThreadId(sourceKey: string, oldThreadId: string): string {
  return deterministicUuid(`t3-import:replacement:${sourceKey}:${oldThreadId}`);
}

export function replacementIdentitySeed(sourceKey: string, oldThreadId: string): string {
  return `replacement:${sourceKey}:${oldThreadId}`;
}

function selectedThread(conversation: CanonicalConversation): CanonicalThread | undefined {
  return conversation.threads.find((thread) => thread.currentBranch) ?? conversation.threads[0];
}

function item(
  thread: CanonicalThread,
  status: ReplaceItemResult["status"],
  oldRecords: StoredLedgerRecord[] = [],
  warning?: string,
): ReplaceItemResult {
  const oldRecord = oldRecords[0];
  const consolidation = oldRecords.length > 1
    ? `Consolidating ${oldRecords.length} imported Claude fragments into one canonical task.`
    : undefined;
  return {
    source: thread.source, sourceId: thread.sourceSessionId, sourceKey: thread.sourceKey,
    status, ...(oldRecord ? { oldThreadId: oldRecord.threadId, projectId: oldRecord.projectId } : {}),
    title: thread.title, turns: thread.turns.length, events: 0, attachments: 0, resumeTransferred: false,
    ...(oldRecords.length > 1 ? { oldThreadIds: oldRecords.map((record) => record.threadId) } : {}),
    warnings: [...thread.warnings, ...(consolidation ? [consolidation] : []), ...(warning ? [warning] : [])],
  };
}

function alreadyCurrentItem(thread: CanonicalThread, oldRecords: StoredLedgerRecord[], newThreadId: string, projectId: string): ReplaceItemResult {
  return { ...item(thread, "already-current", oldRecords), newThreadId, projectId };
}

function primaryRecord(rows: StoredLedgerRecord[], thread: CanonicalThread): StoredLedgerRecord | undefined {
  const canonical = rows.filter((row) => row.isCanonical !== false && row.sourceSessionId === thread.sourceSessionId);
  const exact = canonical.find((row) => row.sourceKey === thread.sourceKey || row.currentSourceKey === thread.sourceKey
    || (thread.leafId && row.sourceLeafId === thread.leafId));
  if (exact) return exact;
  if (thread.source === "claude") return canonical.find((row) => row.resumable) ?? (canonical.length === 1 ? canonical[0] : undefined);
  return canonical.find((row) => row.sourceSessionId === thread.sourceSessionId);
}

function sessionRecords(rows: StoredLedgerRecord[], thread: CanonicalThread, primary: StoredLedgerRecord): StoredLedgerRecord[] {
  if (thread.source !== "claude") return [primary];
  const byId = new Map(rows
    .filter((row) => row.isCanonical !== false && row.sourceSessionId === thread.sourceSessionId && row.projectId === primary.projectId)
    .map((row) => [row.threadId, row]));
  byId.set(primary.threadId, primary);
  return [primary, ...[...byId.values()].filter((row) => row.threadId !== primary.threadId)];
}

function projectedThread(value: NativeThread | undefined): Record<string, any> | undefined {
  return value?.thread ?? value?.snapshot?.projection?.thread;
}

function projectedRecords(value: NativeThread | undefined): Record<string, any> | undefined {
  if (value?.records) return value.records;
  const projection = value?.snapshot?.projection as Record<string, any> | undefined;
  return projection ? {
    thread: projection.thread,
    messages: projection.messages,
    turnItems: projection.turnItems,
    plans: projection.plans,
    providerThreads: projection.providerThreads,
    providerTurns: projection.providerTurns,
  } : undefined;
}

function importedEventIds(record: StoredLedgerRecord, threadId: string): string[] {
  const seed = record.identitySeed || record.sourceKey;
  return [deterministicUuid(`t3-import:v2:event:${seed}:thread-created`),
    deterministicUuid(`t3-import:v2:event:${seed}:provider-thread`)];
}

function hasOwnedCreation(value: NativeThread | undefined, record: StoredLedgerRecord): boolean {
  const events = value?.events ?? [];
  return importedEventIds(record, record.threadId).every((id) => events.some((event) => event.id === id));
}

async function strictEventOwnership(paths: TargetPaths, value: NativeThread | undefined, expectedEvents: Array<Record<string, unknown>>): Promise<boolean> {
  if (!value) return false;
  const actual = value.events;
  if (!Array.isArray(actual) || actual.length === 0 || !actual.every((event, index) =>
    Number.isSafeInteger(event.sequence) && event.sequence > 0
    && (index === 0 || event.sequence > actual[index - 1]!.sequence))) return false;
  const expectedIds = new Set(expectedEvents.map((event) => String(event.id)));
  const extra = actual.filter((event) => !expectedIds.has(event.id));
  if (extra.length > 0) {
    // Opening a task adds a native visit without taking ownership of its history.
    // Decode extra events through the pinned helper; arbitrary native edits must
    // still fail the ownership check.
    const inspected = await callV2Native(paths, {
      op: "inspect", threadIds: [value.threadId], selectedEventIds: extra.map((event) => event.id),
    });
    const details = inspected.threads?.find((thread) => thread.threadId === value.threadId)?.selectedEventDetails;
    if (!inspected.ok || !details || details.length !== extra.length || !extra.every((event) =>
      details.some((detail) => detail.id === event.id && detail.sequence === event.sequence
        && detail.event.id === event.id && detail.event.threadId === value.threadId
        && detail.event.type === "thread.visited"))) return false;
  }
  const owned = actual.filter((event) => expectedIds.has(event.id));
  return owned.length > 0 && owned.length <= expectedEvents.length
    && owned.every((event, index) => event.id === String(expectedEvents[index]?.id));
}

type NativeProjectionMarker = NativeProjectionIdentityV1;

function nativeProjectionMarker(record: StoredLedgerRecord): NativeProjectionMarker | undefined {
  const marker = (record.checkpoint as unknown as { nativeProjection?: NativeProjectionMarker } | undefined)?.nativeProjection;
  return marker?.kind === "semantic-native-prefix-v1" && Array.isArray(marker.messages)
    && marker.messages.every((id) => typeof id === "string")
    && Array.isArray(marker.turnItems) && marker.turnItems.every((id) => typeof id === "string")
    && Array.isArray(marker.plans) && marker.plans.every((id) => typeof id === "string") ? marker : undefined;
}

function verifiedNativePrefix(value: NativeThread | undefined, record: StoredLedgerRecord, expectedEvents: Array<Record<string, unknown>>, native = false): boolean {
  const marker = nativeProjectionMarker(record);
  const records = projectedRecords(value);
  if (!marker || !records?.messages || !records.turnItems || !records.plans) return false;
  const expectedMessages = expectedEvents.filter((event) => event.type === "message.updated").map((event) => event.payload as Record<string, any>);
  const expectedItems = expectedEvents.filter((event) => event.type === "turn-item.updated").map((event) => event.payload as Record<string, any>);
  const expectedPlans = expectedEvents.filter((event) => event.type === "plan.updated").map((event) => event.payload as Record<string, any>);
  const groups: Array<[Array<Record<string, any>>, string[], Array<Record<string, any>>]> = [
    [records.messages, marker.messages, expectedMessages],
    [records.turnItems, marker.turnItems, expectedItems],
    [records.plans, marker.plans, expectedPlans],
  ];
  if (groups.some(([actual, ids, expected]) => ids.length > expected.length || actual.length !== expected.length
    || actual.slice(0, ids.length).some((row, index) => row.id !== ids[index])
    || !expected.slice(ids.length).every((row, offset) => actual[ids.length + offset]?.id === row.id))) return false;
  if (!nativeProjectionIdentityMatches(records, marker)
    || !projectedHistoryMatches(records, expectedEvents, { identity: native ? "native-semantic" : "semantic" })) return false;
  return expectedItems.every((expected, index) => {
    if (typeof expected.messageId !== "string") return true;
    const messageIndex = expectedMessages.findIndex((message) => message.id === expected.messageId);
    if (messageIndex < 0) return true;
    const expectedMessageId = messageIndex < marker.messages.length ? marker.messages[messageIndex] : expectedMessages[messageIndex]!.id;
    return records.turnItems![index]?.messageId === expectedMessageId;
  });
}

function nativeBinding(value: NativeThread | undefined): Record<string, any> | undefined {
  const shell = projectedThread(value);
  const records = projectedRecords(value);
  const bindings = records?.providerThreads as Array<Record<string, any>> | undefined;
  return bindings?.find((binding) => binding.id === shell?.activeProviderThreadId);
}

function liveNative(value: NativeThread | undefined): boolean {
  return value?.exists === true && projectedThread(value)?.deletedAt == null;
}

async function inspect(paths: TargetPaths, threadIds: string[], projectIds: string[] = []) {
  return callV2Native(paths, { op: "inspect", threadIds, projectIds, includeRecoveryRecords: true });
}

async function buildPlan(conversation: CanonicalConversation, paths: TargetPaths): Promise<ReplacementPlan> {
  const selected = selectedThread(conversation);
  if (!selected) throw writeError(`Conversation ${conversation.summary.id} has no importable task.`);
  const thread = { ...selected, turns: selected.turns.filter(isTerminalTurn) };
  const active = selected.turns.some((turn) => !isTerminalTurn(turn)) || (selected.ignoredInProgressTurns ?? 0) > 0;
  if (active) return { conversation, thread, oldRecords: [], result: item(thread, "active-source", [], "The provider conversation has an active or indeterminate turn. Retry replacement after it settles.") };
  if (thread.source === "claude" && conversation.summary.branches !== 1) {
    return { conversation, thread, oldRecords: [], result: item(thread, "branch-replace-unsupported", [], "Claude replacement requires exactly one identified non-sidechain leaf.") };
  }

  const rows = replacementLedgerRows(paths, thread.source);
  const oldRecord = primaryRecord(rows, thread);
  if (!oldRecord) {
    return { conversation, thread, oldRecords: [], result: item(thread, "not-imported", [], "Conversation has no unambiguous canonical t3-import ledger owner.") };
  }
  const oldRecords = sessionRecords(rows, thread, oldRecord);
  const newThreadId = replacementThreadId(thread.sourceKey, oldRecord.threadId);
  const identitySeed = replacementIdentitySeed(thread.sourceKey, oldRecord.threadId);
  const response = await inspect(paths, [...new Set([...oldRecords.map((record) => record.threadId), newThreadId])], [oldRecord.projectId]);
  if (!response.ok || response.integrity !== "ok" || response.profile?.isV2Schema !== true) {
    return { conversation, thread, oldRecord, oldRecords, replacementId: newThreadId,
      result: item(thread, "history-conflict", oldRecords, "The pinned native reader could not validate this v2 target.") };
  }
  const nativeById = new Map((response.threads ?? []).map((value) => [value.threadId, value as NativeThread]));
  const oldThreads = oldRecords.map((record) => nativeById.get(record.threadId)).filter((value): value is NativeThread => Boolean(value));
  const candidate = nativeById.get(newThreadId);
  if (candidate?.exists && oldThreads.length === oldRecords.length) {
    const candidateShell = projectedThread(candidate);
    const binding = nativeBinding(candidate);
    const providerInstance = String(candidateShell?.providerInstanceId ?? "");
    const canContinue = oldRecord.resumable && binding?.nativeThreadRef != null;
    if (candidateShell?.projectId === oldRecord.projectId && binding?.status === "idle" && providerInstance) {
      const selection = { conversation, resume: canContinue };
      const planned = planV2Thread(selection, thread, paths, oldRecord.projectId, false, providerInstance, {
        threadId: newThreadId, identitySeed, disableResume: !canContinue,
      });
      const expectedIds = planned.events.map((event) => String(event.id));
      const actualIds = (candidate.events ?? []).map((event) => event.id);
      const oldRetired = oldThreads.every((value, index) => {
        const tombstoneId = deterministicUuid(`t3-import:v2:event:${identitySeed}:retire:${oldRecords[index]!.threadId}`);
        return !liveNative(value) && value.events?.some((event) => event.id === tombstoneId);
      });
      const refMatches = canContinue
        ? binding.nativeThreadRef?.nativeId === (thread.source === "claude" ? thread.sourceSessionId : String(thread.resumeCursor?.threadId ?? thread.sourceSessionId))
          && (thread.source !== "claude" || binding.nativeConversationHeadRef?.nativeId === thread.resumeCursor?.resumeSessionAt)
        : binding.nativeThreadRef === null && binding.nativeConversationHeadRef === null;
      if (oldRetired && refMatches && projectedHistoryMatches(projectedRecords(candidate), planned.events)
        && actualIds.length === expectedIds.length && actualIds.every((id, index) => id === expectedIds[index])) {
        return { conversation, thread, oldRecord, oldRecords, planned, oldThreads, replacementId: newThreadId, recoverLedger: true,
          recoverySequences: [
            ...(candidate.events ?? []).map((event) => ({ eventId: event.id, threadId: newThreadId, sequence: event.sequence })),
            ...oldThreads.flatMap((value) => (value.events ?? []).map((event) => ({ eventId: event.id, threadId: value.threadId, sequence: event.sequence }))),
          ], result: alreadyCurrentItem(thread, oldRecords, newThreadId, oldRecord.projectId) };
      }
    }
  }
  const source = nativeById.get(oldRecord.threadId);
  const marker = nativeProjectionMarker(oldRecord);
  const mayVerifyUpgrade = oldRecord.targetId !== targetHash(paths) && projectedThread(source)?.historyOrigin === "v1_import";
  if (!source || !projectedThread(source) || (!marker && !mayVerifyUpgrade && !hasOwnedCreation(source, oldRecord))
    || projectedThread(source)?.projectId !== oldRecord.projectId
    || (mayVerifyUpgrade && !liveNative(source))
    || (!marker && !mayVerifyUpgrade && projectedThread(source)?.historyOrigin !== "v1_import")) {
    return { conversation, thread, oldRecord, oldRecords, oldThreads, replacementId: newThreadId,
      result: item(thread, "target-missing", oldRecords, "The native task no longer matches its canonical ledger owner.") };
  }
  if (oldThreads.length !== oldRecords.length || oldThreads.some((value, index) => {
    const record = oldRecords[index]!;
    const shell = projectedThread(value);
    const hasMarker = nativeProjectionMarker(record) !== undefined;
    const canVerifyUpgrade = record.targetId !== targetHash(paths) && shell?.historyOrigin === "v1_import";
    return !shell || shell.projectId !== oldRecord.projectId || (!hasMarker && !canVerifyUpgrade && shell.historyOrigin !== "v1_import")
      || (!hasMarker && !canVerifyUpgrade && !hasOwnedCreation(value, record));
  })) {
    return { conversation, thread, oldRecord, oldRecords, oldThreads, replacementId: newThreadId,
      result: item(thread, "history-conflict", oldRecords, "One or more imported Claude fragments cannot be proven to share this project and source session.") };
  }
  const binding = nativeBinding(source);
  const providerInstance = String(projectedThread(source)?.providerInstanceId ?? "");
  let upgradedPrefix: ReplacementPlan["upgradedPrefix"];
  const fromLegacyTarget = oldRecord.targetId !== targetHash(paths);
  if (fromLegacyTarget && projectedThread(source)?.historyOrigin === "v1_import" && providerInstance) {
    const prefixCanResume = oldRecord.resumable && (thread.source !== "claude" || Boolean(oldRecord.nativeConversationHeadId));
    const proof = verifyUpgradedPrefix({
      sourceThread: thread,
      target: source as V2ThreadReply,
      expected: {
        threadId: oldRecord.threadId,
        projectId: oldRecord.projectId,
        providerInstanceId: providerInstance,
        sourceSessionId: oldRecord.sourceSessionId,
        nativeThreadId: String(thread.resumeCursor?.threadId ?? thread.sourceSessionId),
        sourceFingerprint: oldRecord.sourceFingerprint,
        currentFingerprint: conversation.fingerprint,
        identitySeed: oldRecord.identitySeed || oldRecord.sourceKey,
        ...(oldRecord.checkpoint ? { checkpoint: oldRecord.checkpoint } : {}),
        ...(oldRecord.nativeConversationHeadId ? { nativeConversationHeadId: oldRecord.nativeConversationHeadId } : {}),
        resumable: prefixCanResume,
      },
      planPrefix: (prefixThread) => {
        const savedPrefix = thread.source === "claude" && oldRecord.nativeConversationHeadId
          ? { ...prefixThread, resumeCursor: { ...prefixThread.resumeCursor, resumeSessionAt: oldRecord.nativeConversationHeadId } }
          : prefixThread;
        const prefixConversation = { ...conversation, threads: [savedPrefix] };
        return planV2Thread({ conversation: prefixConversation, resume: prefixCanResume }, savedPrefix, paths,
          oldRecord.projectId, false, providerInstance, {
            threadId: oldRecord.threadId,
            identitySeed: oldRecord.identitySeed || oldRecord.sourceKey,
            disableResume: !prefixCanResume,
          });
      },
    });
    if (proof.status === "conflict") {
      return { conversation, thread, oldRecord, oldRecords, oldThreads, replacementId: newThreadId,
        result: item(thread, "history-conflict", oldRecords, `${proof.reason} Preserve it and resolve the conflict before replacing.`) };
    }
    const event = proof.binding === "absent"
      ? proof.prefixPlan.events.find((candidateEvent) => candidateEvent.type === "provider-thread.updated")
      : undefined;
    if (proof.binding === "absent" && !event) {
      return { conversation, thread, oldRecord, oldRecords, oldThreads, replacementId: newThreadId,
        result: item(thread, "history-conflict", oldRecords, "The converted task has an unexpected provider binding state. Preserve it and resolve the conflict before replacing.") };
    }
    upgradedPrefix = { plan: proof.prefixPlan, expectedSnapshot: proof.expectedSnapshot, ...(event ? { event } : {}), attach: proof.binding === "absent" };
  }
  if (!binding || !providerInstance || binding.status !== "idle") {
    if (!upgradedPrefix) return { conversation, thread, oldRecord, oldRecords, oldThreads, replacementId: newThreadId,
      result: item(thread, "active-source", oldRecords, "The imported provider session is active or its native binding cannot be verified.") };
    if (binding && binding.status !== "idle") return { conversation, thread, oldRecord, oldRecords, oldThreads, replacementId: newThreadId,
      result: item(thread, "active-source", oldRecords, "The converted provider session is active; retry replacement after it settles.") };
  }
  const canContinue = upgradedPrefix
    ? oldRecord.resumable
    : oldRecord.resumable && binding!.nativeThreadRef != null;
  const selection = { conversation, resume: canContinue };
  const currentPlan = planV2Thread(selection, thread, paths, oldRecord.projectId, false, providerInstance, {
    threadId: oldRecord.threadId, identitySeed: oldRecord.identitySeed || oldRecord.sourceKey,
    disableResume: !canContinue,
  });
  if (!marker && !upgradedPrefix && liveNative(source) && !await strictEventOwnership(paths, source, currentPlan.events)) {
    return { conversation, thread, oldRecord, oldRecords, oldThreads, replacementId: newThreadId,
      result: item(thread, "history-conflict", oldRecords, "The native event stream is not the deterministic t3-import history owned by this ledger record.") };
  }
  const identityThread = { ...thread, sourceKey: oldRecord.identitySeed || oldRecord.sourceKey };
  const normalizedTurns = identityThread.turns.map((turn) => nativeExpectedTurnEvents(
    planV2Thread(selection, { ...identityThread, turns: [turn] }, paths, oldRecord.projectId, false, providerInstance,
      { threadId: oldRecord.threadId, identitySeed: identityThread.sourceKey, disableResume: !canContinue }),
    turn, thread.source === "claude" ? "claudeAgent" : "codex").events);
  const normalizedHistory = binding
    ? reconcileNativeHistory(source as V2ThreadReply, identityThread, binding, normalizedTurns)
    : { target: source as V2ThreadReply, supplementalEvents: [], verified: false };
  const verifiedSource = normalizedHistory.target as NativeThread;
  const priorView = { exists: true, thread: projectedThread(verifiedSource), records: projectedRecords(verifiedSource) };
  const historyVerified = upgradedPrefix ? true : marker ? verifiedNativePrefix(verifiedSource, oldRecord, currentPlan.events, normalizedHistory.verified) && normalizedHistory.supplementalEvents.length === 0
    : projectedHistoryMatches(priorView.records, currentPlan.events);
  const unchanged = currentPlan.resumable === canContinue
    && historyVerified
    && (upgradedPrefix || nativeBinding(source)?.providerInstanceId === currentPlan.provider.instanceId)
    && (upgradedPrefix ? true : canContinue
      ? binding!.nativeThreadRef?.nativeId === (thread.source === "claude" ? thread.sourceSessionId : String(thread.resumeCursor?.threadId ?? thread.sourceSessionId))
        && (thread.source !== "claude" || binding!.nativeConversationHeadRef?.nativeId === thread.resumeCursor?.resumeSessionAt
          || (binding!.nativeConversationHeadRef == null && normalizedHistory.verified))
      : binding!.nativeThreadRef === null && binding!.nativeConversationHeadRef === null);
  if (!upgradedPrefix && unchanged && liveNative(source)) {
    return { conversation, thread, oldRecord, oldRecords, oldThreads, replacementId: newThreadId, recoverLedger: true,
      result: alreadyCurrentItem(thread, oldRecords, newThreadId, oldRecord.projectId) };
  }

  const planned = planV2Thread(selection, thread, paths, oldRecord.projectId, false, providerInstance, {
    threadId: newThreadId, identitySeed, disableResume: !canContinue,
  });
  if (candidate?.exists) {
    const records = projectedRecords(candidate);
    const expectedIds = planned.events.map((event) => String(event.id));
    const actualIds = (candidate.events ?? []).map((event) => event.id);
    const oldRetired = oldThreads.every((value) => projectedThread(value)?.deletedAt != null);
    if (oldRetired && projectedHistoryMatches(records, planned.events)
      && actualIds.length === expectedIds.length && actualIds.every((id, index) => id === expectedIds[index])) {
      return { conversation, thread, oldRecord, oldRecords, planned, oldThreads, replacementId: newThreadId, recoverLedger: true,
        recoverySequences: [
          ...(candidate.events ?? []).map((event) => ({ eventId: event.id, threadId: newThreadId, sequence: event.sequence })),
          ...oldThreads.flatMap((value) => (value.events ?? []).map((event) => ({ eventId: event.id, threadId: value.threadId, sequence: event.sequence }))),
        ],
        result: alreadyCurrentItem(thread, oldRecords, newThreadId, oldRecord.projectId) };
    }
    return { conversation, thread, oldRecord, oldRecords, planned, oldThreads, replacementId: newThreadId,
      result: item(thread, "history-conflict", oldRecords, "The deterministic replacement ID already contains different history. Preserve it and resolve the conflict before retrying.") };
  }

  const result = item(thread, "dry-run", oldRecords);
  result.newThreadId = newThreadId;
  result.projectId = oldRecord.projectId;
  result.events = planned.events.length + oldRecords.filter((record) => liveNative(nativeById.get(record.threadId))).length;
  result.attachments = planned.attachments;
  result.resumeTransferred = planned.resumable;
  return { conversation, thread, oldRecord, oldRecords, planned, oldThreads, ...(upgradedPrefix ? { upgradedPrefix } : {}), replacementId: newThreadId, result };
}

export async function inspectNightlyV2Replacement(
  conversation: CanonicalConversation,
  paths: TargetPaths,
): Promise<ConversationReplacePreview> {
  const plan = await buildPlan(conversation, paths);
  const status = plan.result.status === "dry-run" ? "replaceable" : plan.result.status;
  return {
    sourceId: plan.result.sourceId, status: status as ConversationReplacePreview["status"],
    selectable: status === "replaceable", previouslyImported: status !== "not-imported",
    turns: plan.result.turns, events: plan.result.events, attachments: plan.result.attachments,
    ...(plan.result.oldThreadId ? { oldThreadId: plan.result.oldThreadId } : {}),
    ...(plan.result.oldThreadIds ? { oldThreadIds: plan.result.oldThreadIds } : {}),
    ...(plan.replacementId ? { newThreadId: plan.replacementId } : {}), warnings: plan.result.warnings,
  };
}

function oldBindings(plan: ReplacementPlan) {
  return plan.oldRecords.map((record, index) => {
    const value = plan.oldThreads?.[index];
    const binding = nativeBinding(value);
    return {
      threadId: record.threadId,
      providerThreadId: String(binding?.id ?? ""),
      nativeThreadRef: binding?.nativeThreadRef ?? null,
      expectedConversationHeadRef: binding?.nativeConversationHeadRef ?? null,
    };
  });
}

function replacementEvents(plan: ReplacementPlan): Array<Record<string, unknown>> {
  const planned = plan.planned!;
  const now = new Date().toISOString();
  const retired = plan.oldRecords.flatMap((record, index) => {
    const value = plan.oldThreads?.[index];
    if (!liveNative(value)) return [];
    const shell = projectedThread(value)!;
    const providerThreadId = String(shell.activeProviderThreadId ?? "");
    return [{
      id: deterministicUuid(`t3-import:v2:event:${planned.identitySeed}:retire:${record.threadId}`),
      type: "thread.deleted", threadId: record.threadId, providerInstanceId: shell.providerInstanceId,
      occurredAt: now,
      payload: { ...shell, deletedAt: now, titleRegeneration: null, updatedAt: now },
    }];
  });
  return [...planned.events, ...retired];
}

function conflictResult(plan: ReplacementPlan, message: string): ReplaceItemResult {
  return {
    ...plan.result, status: "history-conflict",
    warnings: [...plan.result.warnings, message],
  };
}

function recordFor(plan: ReplacementPlan, paths: TargetPaths, backup: string, sequences: Array<{ threadId: string; sequence: number }>): LedgerRecord {
  const planned = plan.planned!;
  const ownSequences = sequences.filter((event) => event.threadId === planned.threadId).map((event) => event.sequence);
  if (ownSequences.length !== planned.events.length || ownSequences.some((sequence) => !Number.isSafeInteger(sequence))) {
    throw writeError("The native helper did not return every replacement event sequence.");
  }
  const replacedAt = new Date().toISOString();
  return {
    targetId: targetHash(paths), source: plan.thread.source, sourceSessionId: plan.thread.sourceSessionId,
    sourceKey: plan.thread.sourceKey, sourceFingerprint: plan.conversation.fingerprint,
    projectId: planned.projectId, threadId: planned.threadId, importedAt: replacedAt,
    importerVersion: IMPORTER_VERSION, migration: 61, firstSequence: Math.min(...ownSequences),
    lastSequence: Math.max(...ownSequences), resumable: planned.resumable, backupPath: backup,
    warnings: [...plan.result.warnings, ...planned.warnings], identitySeed: planned.identitySeed,
    currentSourceKey: plan.thread.sourceKey, ...(plan.thread.leafId ? { sourceLeafId: plan.thread.leafId } : {}),
    ...(planned.resumable && plan.thread.source === "claude" && typeof plan.thread.resumeCursor?.resumeSessionAt === "string"
      ? { nativeConversationHeadId: plan.thread.resumeCursor.resumeSessionAt } : {}),
    sourceTitle: plan.thread.title, checkpoint: checkpointForThread(plan.thread), syncedAt: replacedAt,
    isCanonical: true, replacedAt,
  };
}

function outcome(plans: ReplacementPlan[], dryRun: boolean): ReplaceRunResult["status"] {
  if (dryRun && plans.some((plan) => plan.result.status === "dry-run")) return "dry-run";
  const replaced = plans.some((plan) => plan.result.status === "replaced");
  const conflicts = plans.some((plan) => ["not-imported", "active-source", "branch-replace-unsupported", "target-missing", "history-conflict"].includes(plan.result.status));
  if (replaced && conflicts) return "mixed";
  if (conflicts) return "conflict";
  return replaced ? "replaced" : "already-current";
}

export async function replaceNightlyV2(
  selections: ReplaceSelection[],
  paths: TargetPaths,
  options: { dryRun: boolean },
  db: Database.Database,
): Promise<ReplaceRunResult> {
  const plans: ReplacementPlan[] = [];
  for (const selection of selections) plans.push(await buildPlan(selection.conversation, paths));
  const writable = plans.filter((plan) => plan.planned && plan.oldRecord && plan.replacementId && plan.result.status === "dry-run");
  const ledgerRecoveries = plans.filter((plan) => plan.recoverLedger && plan.planned && plan.oldRecord);
  if (options.dryRun || (writable.length === 0 && ledgerRecoveries.length === 0)) {
    const results = plans.map((plan) => plan.result.status === "dry-run"
      ? { ...plan.result, status: "dry-run" as const } : plan.result);
    return {
      schemaVersion: 1, status: outcome(plans, options.dryRun), target: paths.dbPath, migration: 61,
      backup: null, results, warnings: [], hasConflicts: results.some((result) => result.status === "history-conflict" || result.status === "target-missing"),
    };
  }
  if (writable.reduce((total, plan) => total + plan.result.events, 0) > 5000) {
    throw safetyError("Replacement exceeds the safe one-launch native event limit. Replace fewer conversations at a time.");
  }
  let backup: string | null = null;
  const backupByPlan = new Map<ReplacementPlan, string>();
  const receiptsByPlan = new Map<ReplacementPlan, ReplacementReceipt>();
  const warnings: string[] = [];
  for (const plan of ledgerRecoveries) {
    try {
      const receipt = await readReplacementReceipt(paths, plan);
      if (receipt) {
        receiptsByPlan.set(plan, receipt);
        backupByPlan.set(plan, receipt.backupPath);
        backup ??= receipt.backupPath;
      }
    } catch (error) {
      warnings.push(`The committed replacement was verified, but its backup receipt could not be validated; ledger recovery was skipped (${error instanceof Error ? error.message : String(error)}).`);
    }
  }
  const pendingReceipts = new Set<ReplacementPlan>();
  for (const plan of writable) {
    const receipt = await readReplacementReceipt(paths, plan);
    if (receipt) {
      receiptsByPlan.set(plan, receipt);
      backupByPlan.set(plan, receipt.backupPath);
      backup ??= receipt.backupPath;
    } else pendingReceipts.add(plan);
  }
  if (pendingReceipts.size > 0) {
    const createdBackup = createBackup(db, paths);
    backup ??= createdBackup;
    for (const plan of pendingReceipts) {
      const receipt = await writeReplacementReceipt(paths, plan, createdBackup);
      receiptsByPlan.set(plan, receipt);
      backupByPlan.set(plan, receipt.backupPath);
    }
  }
  for (const plan of ledgerRecoveries) {
    const receipt = receiptsByPlan.get(plan);
    if (!receipt) {
      warnings.push("The committed replacement is intact, but no durable pre-mutation backup receipt exists. Its ledger mapping was left unchanged rather than pointing to the original import backup.");
      continue;
    }
    const sequences = plan.recoverySequences ?? plan.oldThreads?.flatMap((value) => (value.events ?? []).map((event) => ({
      eventId: event.id, threadId: value.threadId, sequence: event.sequence,
    }))) ?? [];
    try {
      const record = recordFor(plan, paths, receipt.backupPath, sequences);
      recordConsolidation(plan.oldRecords, record);
      removeReplacementReceipt(paths, plan);
    } catch (error) {
      warnings.push(`The committed replacement is verified, but its ledger ownership could not be recovered: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }
  for (const plan of writable) {
    const planned = plan.planned!;
    if (plan.upgradedPrefix?.attach) {
      verifyOrRecoverV2Assets(plan.upgradedPrefix.plan, paths, true, materializeAssets);
      const attached = await callV2Native(paths, {
        op: "attach-upgraded-binding",
        threadId: plan.oldRecord!.threadId,
        projectId: plan.oldRecord!.projectId,
        providerInstanceId: String(projectedThread(plan.oldThreads?.[0])?.providerInstanceId ?? ""),
        expectedSnapshot: plan.upgradedPrefix.expectedSnapshot,
        event: plan.upgradedPrefix.event,
      });
      if (!attached.ok || (attached.outcome !== "attached" && attached.outcome !== "already-attached")) {
        plan.result = conflictResult(plan, `The converted task binding changed during recovery (${attached.reason ?? attached.error ?? "native attach conflict"}).`);
        continue;
      }
      const refreshed = await inspect(paths, plan.oldRecords.map((record) => record.threadId));
      if (!refreshed.ok || refreshed.integrity !== "ok") {
        plan.result = conflictResult(plan, "The converted task was attached, but the native readback could not confirm its source binding. The backup is preserved.");
        continue;
      }
      const refreshedById = new Map((refreshed.threads ?? []).map((value) => [value.threadId, value as NativeThread]));
      plan.oldThreads = plan.oldRecords.map((record) => refreshedById.get(record.threadId)).filter((value): value is NativeThread => Boolean(value));
      const source = plan.oldThreads[0];
      const binding = nativeBinding(source);
      const shell = projectedThread(source);
      if (plan.oldThreads.length !== plan.oldRecords.length || !liveNative(source) || !binding
        || binding.status !== "idle" || binding.appThreadId !== plan.oldRecord!.threadId
        || binding.providerInstanceId !== shell?.providerInstanceId) {
        plan.result = conflictResult(plan, "The converted task was attached, but its native readback does not show the exact idle source binding. The backup is preserved.");
        continue;
      }
    }
    const oldBindingList = oldBindings(plan);
    if (oldBindingList.some((binding) => !binding.providerThreadId)) {
      plan.result = conflictResult(plan, "The source provider binding is missing or inconsistent; no replacement was written.");
      continue;
    }
    const assets = materializeAssets([planned], paths, randomUUID());
    const nativeEvents = replacementEvents(plan);
    let response;
    try {
      response = await callV2Native(paths, {
        op: "replace", oldThreadIds: plan.oldRecords.map((record) => record.threadId), oldBindings: oldBindingList,
        transferRuntimeFromThreadId: plan.oldRecord!.threadId,
        replacementThreadId: planned.threadId, projectId: planned.projectId,
        providerInstanceId: planned.provider.instanceId,
        replacementProviderThreadId: (planned.events.find((event) => event.type === "provider-thread.updated")?.payload as Record<string, unknown>)?.id,
        driver: planned.provider.providerName,
        nativeThreadRef: (planned.events.find((event) => event.type === "provider-thread.updated")?.payload as Record<string, any>)?.nativeThreadRef ?? null,
        expectedConversationHeadRef: (planned.events.find((event) => event.type === "provider-thread.updated")?.payload as Record<string, any>)?.nativeConversationHeadRef ?? null,
        events: nativeEvents,
      });
    } catch (error) {
      assets.cleanup();
      try {
        const after = await inspect(paths, [planned.threadId]);
        const target = after.threads?.find((value) => value.threadId === planned.threadId);
        if (after.ok === true && after.integrity === "ok" && target?.exists === false) {
          for (const path of assets.created) rmSync(path, { force: true });
        }
      } catch { /* Keep assets if native commit state cannot be confirmed. */ }
      throw writeError(`Replacement failed. The verified backup is ${backup}. ${error instanceof Error ? error.message : String(error)}`, error);
    }
    assets.cleanup();
    const cleanupUncommittedAssets = async () => {
      try {
        const after = await inspect(paths, [planned.threadId]);
        const target = after.threads?.find((value) => value.threadId === planned.threadId);
        if (after.ok === true && after.integrity === "ok" && target?.exists === false) {
          for (const path of assets.created) rmSync(path, { force: true });
        }
      } catch { /* Keep files if the commit state cannot be confirmed. */ }
    };
    if (!response.ok || (response.outcome !== "replaced" && response.outcome !== "already-replaced")) {
      await cleanupUncommittedAssets();
      if (response.outcome === "replace-conflict") {
        plan.result = conflictResult(plan, response.error ?? "Native replacement identity checks failed.");
        continue;
      }
      throw writeError(`Native replacement did not commit cleanly. The verified backup is ${backup}. ${response.error ?? response.outcome ?? "unknown result"}`);
    }
    const storedSequences = response.storedSequences ?? [];
    const planBackup = backupByPlan.get(plan);
    if (!planBackup) throw writeError("The replacement recovery receipt is missing after the native commit.");
    const record = recordFor(plan, paths, planBackup, storedSequences);
    try {
      recordConsolidation(plan.oldRecords, record);
      removeReplacementReceipt(paths, plan);
    } catch (error) {
      warnings.push(`Replacement succeeded, but its ledger ownership could not be updated: ${error instanceof Error ? error.message : String(error)}. Retry replacement to recover the committed native batch.`);
    }
    plan.result = {
      ...plan.result, status: "replaced", sequence: { first: record.firstSequence, last: record.lastSequence },
      newThreadId: planned.threadId, resumeTransferred: planned.resumable,
      events: nativeEvents.length, attachments: planned.attachments,
    };
  }
  const results = plans.map((plan) => plan.result);
  return { schemaVersion: 1, status: outcome(plans, false), target: paths.dbPath, migration: 61,
      backup, results, warnings, hasConflicts: results.some((result) => ["history-conflict", "target-missing", "not-imported", "active-source", "branch-replace-unsupported"].includes(result.status)) };
}
