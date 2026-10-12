import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
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
import { checkpointForThread } from "../../core/checkpoint.js";
import { canonicalPath, deterministicUuid, sha256 } from "../../core/util.js";
import { safetyError, writeError } from "../../core/errors.js";
import { listImports, recordConsolidation, type LedgerRecord, type StoredLedgerRecord } from "../ledger.js";
import {
  callV2Native,
  createBackup,
  materializeAssets,
  planV2Thread,
  IMPORTER_VERSION,
  type V2Plan,
} from "../importer.js";
import { projectedHistoryMatches } from "./history.js";

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
  replacementId?: string;
  recoverLedger?: boolean;
  recoverySequences?: Array<{ eventId: string; threadId: string; sequence: number }>;
  result: ReplaceItemResult;
};

const targetHash = (paths: TargetPaths) => sha256(canonicalPath(paths.dbPath));

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

function strictEventOwnership(value: NativeThread | undefined, expectedEvents: Array<Record<string, unknown>>): boolean {
  const actual = value?.events;
  if (!Array.isArray(actual) || actual.length > expectedEvents.length) return false;
  return actual.length > 0 && actual.every((event, index) => event.id === String(expectedEvents[index]?.id)
    && Number.isSafeInteger(event.sequence) && event.sequence > 0
    && (index === 0 || event.sequence > actual[index - 1]!.sequence));
}

type NativeProjectionMarker = { kind: "semantic-native-prefix-v1"; messages: string[]; turnItems: string[]; plans: string[] };

function nativeProjectionMarker(record: StoredLedgerRecord): NativeProjectionMarker | undefined {
  const marker = (record.checkpoint as unknown as { nativeProjection?: NativeProjectionMarker } | undefined)?.nativeProjection;
  return marker?.kind === "semantic-native-prefix-v1" && Array.isArray(marker.messages)
    && Array.isArray(marker.turnItems) && Array.isArray(marker.plans) ? marker : undefined;
}

function verifiedNativePrefix(value: NativeThread | undefined, record: StoredLedgerRecord, expectedEvents: Array<Record<string, unknown>>): boolean {
  const marker = nativeProjectionMarker(record);
  const records = projectedRecords(value);
  if (!marker || !records?.messages || !records.turnItems || !records.plans) return false;
  const groups: Array<[Array<Record<string, any>>, string[]]> = [
    [records.messages, marker.messages],
    [records.turnItems, marker.turnItems],
    [records.plans, marker.plans],
  ];
  if (groups.some(([actual, ids]) => actual.length !== ids.length || actual.some((row, index) => row.id !== ids[index]))) return false;
  const counts = new Map<string, number>([["message.updated", marker.messages.length], ["turn-item.updated", marker.turnItems.length], ["plan.updated", marker.plans.length]]);
  const expectedPrefix = expectedEvents.filter((event) => {
    const count = counts.get(String(event.type)) ?? 0;
    if (count < 1) return false;
    counts.set(String(event.type), count - 1);
    return true;
  });
  if ([...counts.values()].some((count) => count !== 0)) return false;
  return projectedHistoryMatches(records, expectedPrefix, { identity: "semantic" });
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
  return callV2Native(paths, { op: "inspect", threadIds, projectIds });
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

  const rows = listImports(targetHash(paths), thread.source);
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
          ], result: item(thread, "already-current", oldRecords) };
      }
    }
  }
  const source = nativeById.get(oldRecord.threadId);
  const marker = nativeProjectionMarker(oldRecord);
  if (!source || !projectedThread(source) || (!marker && !hasOwnedCreation(source, oldRecord))
    || projectedThread(source)?.projectId !== oldRecord.projectId
    || (!marker && projectedThread(source)?.historyOrigin !== "v1_import")) {
    return { conversation, thread, oldRecord, oldRecords, oldThreads, replacementId: newThreadId,
      result: item(thread, "target-missing", oldRecords, "The native task no longer matches its canonical ledger owner.") };
  }
  if (oldThreads.length !== oldRecords.length || oldThreads.some((value, index) => {
    const record = oldRecords[index]!;
    const shell = projectedThread(value);
    const hasMarker = nativeProjectionMarker(record) !== undefined;
    return !shell || shell.projectId !== oldRecord.projectId || (!hasMarker && shell.historyOrigin !== "v1_import")
      || (!hasMarker && !hasOwnedCreation(value, record));
  })) {
    return { conversation, thread, oldRecord, oldRecords, oldThreads, replacementId: newThreadId,
      result: item(thread, "history-conflict", oldRecords, "One or more imported Claude fragments cannot be proven to share this project and source session.") };
  }
  const binding = nativeBinding(source);
  const providerInstance = String(projectedThread(source)?.providerInstanceId ?? "");
  if (!binding || !providerInstance || binding.status !== "idle") {
    return { conversation, thread, oldRecord, oldRecords, oldThreads, replacementId: newThreadId,
      result: item(thread, "active-source", oldRecords, "The imported provider session is active or its native binding cannot be verified.") };
  }
  const canContinue = oldRecord.resumable && binding.nativeThreadRef != null;
  const selection = { conversation, resume: canContinue };
  const currentPlan = planV2Thread(selection, thread, paths, oldRecord.projectId, false, providerInstance, {
    threadId: oldRecord.threadId, identitySeed: oldRecord.identitySeed || oldRecord.sourceKey,
    disableResume: !canContinue,
  });
  if (!marker && liveNative(source) && !strictEventOwnership(source, currentPlan.events)) {
    return { conversation, thread, oldRecord, oldRecords, oldThreads, replacementId: newThreadId,
      result: item(thread, "history-conflict", oldRecords, "The native event stream is not the deterministic t3-import history owned by this ledger record.") };
  }
  const priorView = { exists: true, thread: projectedThread(source), records: projectedRecords(source) };
  const historyVerified = marker ? verifiedNativePrefix(source, oldRecord, currentPlan.events)
    : projectedHistoryMatches(priorView.records, currentPlan.events);
  const unchanged = currentPlan.resumable === canContinue
    && historyVerified
    && nativeBinding(source)?.providerInstanceId === currentPlan.provider.instanceId
    && (canContinue
      ? binding.nativeThreadRef?.nativeId === (thread.source === "claude" ? thread.sourceSessionId : String(thread.resumeCursor?.threadId ?? thread.sourceSessionId))
        && (thread.source !== "claude" || binding.nativeConversationHeadRef?.nativeId === thread.resumeCursor?.resumeSessionAt)
      : binding.nativeThreadRef === null && binding.nativeConversationHeadRef === null);
  if (unchanged && liveNative(source)) {
    return { conversation, thread, oldRecord, oldRecords, oldThreads, replacementId: newThreadId, recoverLedger: true,
      result: item(thread, "already-current", oldRecords) };
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
        result: item(thread, "already-current", oldRecords) };
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
  return { conversation, thread, oldRecord, oldRecords, planned, oldThreads, replacementId: newThreadId, result };
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
  const backup = writable.length > 0 ? createBackup(db, paths) : null;
  const warnings: string[] = [];
  for (const plan of ledgerRecoveries) {
    const sequences = plan.recoverySequences ?? plan.oldThreads?.flatMap((value) => (value.events ?? []).map((event) => ({
      eventId: event.id, threadId: value.threadId, sequence: event.sequence,
    }))) ?? [];
    try {
      const record = recordFor(plan, paths, plan.oldRecord!.backupPath ?? backup!, sequences);
      recordConsolidation(plan.oldRecords, record);
    } catch (error) {
      warnings.push(`The committed replacement is verified, but its ledger ownership could not be recovered: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }
  for (const plan of writable) {
    const planned = plan.planned!;
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
        if (!after.threads?.find((value) => value.threadId === planned.threadId)?.snapshot?.projection?.thread) {
          for (const path of assets.created) rmSync(path, { force: true });
        }
      } catch { /* Keep assets if native commit state cannot be confirmed. */ }
      throw writeError(`Replacement failed. The verified backup is ${backup}. ${error instanceof Error ? error.message : String(error)}`, error);
    }
    assets.cleanup();
    if (!response.ok || (response.outcome !== "replaced" && response.outcome !== "already-replaced")) {
      if (response.outcome === "replace-conflict") {
        const check = await inspect(paths, [planned.threadId]);
        if (!check.threads?.find((value) => value.threadId === planned.threadId)?.snapshot?.projection?.thread) {
          for (const path of assets.created) rmSync(path, { force: true });
        }
        plan.result = conflictResult(plan, response.error ?? "Native replacement identity checks failed.");
        continue;
      }
      throw writeError(`Native replacement did not commit cleanly. The verified backup is ${backup}. ${response.error ?? response.outcome ?? "unknown result"}`);
    }
    const storedSequences = response.storedSequences ?? [];
    const record = recordFor(plan, paths, backup!, storedSequences);
    try {
      recordConsolidation(plan.oldRecords, record);
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
