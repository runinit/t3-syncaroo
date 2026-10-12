import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { CanonicalConversation, CanonicalThread, ConversationSyncPreview, SyncItemResult, SyncRunResult, TargetPaths } from "../../core/types.js";
import { isTerminalTurn } from "../../core/types.js";
import { checkpointForThread, legacyTurnSemanticHash, turnSemanticHash, type ImportCheckpoint, type ImportCheckpointV1, type ImportCheckpointV2, type NativeProjectionIdentityV1 } from "../../core/checkpoint.js";
import { canonicalPath, deterministicUuid, sha256 } from "../../core/util.js";
import { safetyError } from "../../core/errors.js";
import { acquireLock, callV2Native, createBackup, materializeAssets, planV2Thread, type V2ThreadReply } from "../importer.js";
import { captureNativeProjectionIdentity, projectedHistoryMatches, nativeProjectionIdentityMatches } from "./history.js";
import { assertT3Closed, validateTargetDatabase } from "../schema.js";
import { listImports, recordImports, type LedgerRecord, type StoredLedgerRecord } from "../ledger.js";

interface V2SourcePlan {
  conversation: CanonicalConversation;
  thread: CanonicalThread;
  record?: StoredLedgerRecord;
  target?: V2ThreadReply;
  status: SyncItemResult["status"];
  added: CanonicalThread["turns"];
  adopted: number;
  warnings: string[];
  providerThread?: Record<string, any>;
  events?: Array<Record<string, unknown>>;
  assets?: Array<any>;
  resumable: boolean;
  nativeHeadId?: string;
  fullPlan?: ReturnType<typeof planV2Thread>;
}

function targetId(paths: TargetPaths): string { return sha256(canonicalPath(paths.dbPath)); }

function sourceRecord(paths: TargetPaths, thread: CanonicalThread): StoredLedgerRecord | undefined {
  const rows = listImports(targetId(paths), thread.source)
    .filter((row) => row.sourceSessionId === thread.sourceSessionId && row.isCanonical !== false && !row.supersededByThreadId);
  const current = rows.filter((row) => row.sourceKey === thread.sourceKey || row.currentSourceKey === thread.sourceKey);
  if (current.length === 1) return current[0];
  if (current.length > 1) return undefined;
  const resumable = rows.filter((row) => row.resumable);
  return resumable.length === 1 ? resumable[0] : rows.length === 1 ? rows[0] : undefined;
}

function checkpointPrefix(thread: CanonicalThread, checkpoint: ImportCheckpoint | undefined): number | undefined {
  if (!checkpoint || thread.turns.length < checkpoint.turns.length) return undefined;
  for (let i = 0; i < checkpoint.turns.length; i++) {
    const saved = checkpoint.turns[i]!;
    const current = thread.turns[i]!;
    if (current.id !== saved.id) return undefined;
    if (checkpoint.version === 1) {
      if (current.status !== "completed" || legacyTurnSemanticHash(current) !== (saved as ImportCheckpointV1["turns"][number]).hash) return undefined;
    } else {
      const v2Saved = saved as ImportCheckpointV2["turns"][number];
      if (!isTerminalTurn(current) || current.status !== v2Saved.status || current.terminalReason !== v2Saved.terminalReason || current.terminalError !== v2Saved.terminalError || turnSemanticHash(current) !== v2Saved.hash) return undefined;
    }
  }
  return checkpoint.turns.length;
}

function recordsOf(target: V2ThreadReply | undefined): NonNullable<V2ThreadReply["records"]> {
  return target?.records ?? {};
}

function providerThreadFor(target: V2ThreadReply, threadId: string): Record<string, any> | undefined {
  const thread = target.records?.thread ?? target.thread;
  const providerThreads = target.records?.providerThreads ?? [];
  const activeId = thread?.activeProviderThreadId;
  const matches = providerThreads.filter((entry) => entry.appThreadId === threadId && (activeId === undefined || entry.id === activeId));
  return matches.length === 1 ? matches[0] as Record<string, any> : undefined;
}

function historyMatchesPrefix(target: V2ThreadReply, plan: ReturnType<typeof planV2Thread>, turns: CanonicalThread["turns"], nativeProjection?: NativeProjectionIdentityV1): boolean {
  const records = recordsOf(target);
  const expected = plan.events;
  const expectedMessages = expected.filter((item) => item.type === "message.updated").map((item) => item.payload as Record<string, any>);
  const actualMessages = records.messages ?? [];
  if (nativeProjection) {
    const expectedItems = expected.filter((item) => item.type === "turn-item.updated").map((item) => item.payload as Record<string, any>);
    const expectedPlans = expected.filter((item) => item.type === "plan.updated").map((item) => item.payload as Record<string, any>);
    if (nativeProjection.messages.length > expectedMessages.length
      || nativeProjection.turnItems.length > expectedItems.length
      || nativeProjection.plans.length > expectedPlans.length
      || actualMessages.length < expectedMessages.length
      || (records.turnItems ?? []).length < expectedItems.length
      || (records.plans ?? []).length < expectedPlans.length) return false;
    if (!nativeProjectionIdentityMatches({
      messages: actualMessages.slice(0, nativeProjection.messages.length),
      turnItems: (records.turnItems ?? []).slice(0, nativeProjection.turnItems.length),
      plans: (records.plans ?? []).slice(0, nativeProjection.plans.length),
    }, nativeProjection)) return false;
    // Rows added after the verified native prefix must retain t3-import's own
    // deterministic IDs; semantic comparison applies only to the saved prefix.
    if (!expectedMessages.slice(nativeProjection.messages.length).every((message, offset) => actualMessages[nativeProjection.messages.length + offset]?.id === message.id)
      || !expectedItems.slice(nativeProjection.turnItems.length).every((item, offset) => records.turnItems?.[nativeProjection.turnItems.length + offset]?.id === item.id)
      || !expectedPlans.slice(nativeProjection.plans.length).every((planRecord, offset) => records.plans?.[nativeProjection.plans.length + offset]?.id === planRecord.id)) return false;
    const prefixRecords = {
      messages: actualMessages.slice(0, expectedMessages.length),
      turnItems: (records.turnItems ?? []).slice(0, expectedItems.length),
      plans: (records.plans ?? []).slice(0, expectedPlans.length),
    };
    if (!projectedHistoryMatches(prefixRecords, expected, { identity: "semantic" })) return false;
    const nativeMessageIds = nativeProjection.messages;
    const actualItems = prefixRecords.turnItems ?? [];
    for (let index = 0; index < expectedItems.length; index++) {
      const sourceMessageId = expectedItems[index]?.messageId;
      if (typeof sourceMessageId !== "string") continue;
      const sourceMessageIndex = expectedMessages.findIndex((message) => message.id === sourceMessageId);
      const actual = actualItems[index];
      if (sourceMessageIndex >= 0) {
        const actualMessageId = sourceMessageIndex < nativeProjection.messages.length
          ? nativeMessageIds[sourceMessageIndex]
          : expectedMessages[sourceMessageIndex]?.id;
        if (actual?.messageId !== actualMessageId) return false;
      }
    }
    return turns.length > 0;
  }
  if (actualMessages.length < expectedMessages.length) return false;
  const messageById = new Map(actualMessages.map((item) => [item.id, item]));
  if (!expectedMessages.every((item) => {
    const actual = messageById.get(item.id) as Record<string, any> | undefined;
    return actual && actual.threadId === item.threadId && actual.role === item.role && actual.text === item.text && JSON.stringify(actual.attachments ?? []) === JSON.stringify(item.attachments ?? []);
  })) return false;

  const expectedItems = expected.filter((item) => item.type === "turn-item.updated").map((item) => item.payload as Record<string, any>);
  const actualItems = records.turnItems ?? [];
  const itemById = new Map(actualItems.map((item) => [item.id, item]));
  if (!expectedItems.every((item) => {
    const actual = itemById.get(item.id) as Record<string, any> | undefined;
    return actual && Object.entries(item).every(([key, value]) => key === "ordinal" || JSON.stringify(actual[key] ?? null) === JSON.stringify(value ?? null));
  })) return false;

  const expectedPlans = expected.filter((item) => item.type === "plan.updated").map((item) => item.payload as Record<string, any>);
  const actualPlans = records.plans ?? [];
  const planById = new Map(actualPlans.map((item) => [item.id, item]));
  if (!expectedPlans.every((item) => {
    const actual = planById.get(item.id) as Record<string, any> | undefined;
    return actual && Object.entries(item).every(([key, value]) => JSON.stringify(actual[key] ?? null) === JSON.stringify(value ?? null));
  })) return false;

  // Ensure the expected prefix is the beginning of the visible transcript. Otherwise an
  // unrecognized/deleted/reordered T3 edit must not be silently adopted.
  const expectedOrdered = expectedMessages.map((item) => item.id);
  const actualPrefix = actualMessages.slice(0, expectedOrdered.length).map((item) => item.id);
  return JSON.stringify(actualPrefix) === JSON.stringify(expectedOrdered) && turns.length > 0;
}

function terminalStatus(item: Record<string, any> | undefined): string | undefined {
  if (!item) return undefined;
  if (item.status === "interrupted" || item.status === "failed" || item.status === "completed") return item.status;
  return undefined;
}

function adoptionCount(target: V2ThreadReply, source: CanonicalThread["turns"], prefixLength: number, prefixMessages: number, plan: ReturnType<typeof planV2Thread>): number {
  const records = recordsOf(target);
  const messages = records.messages ?? [];
  const suffix = messages.slice(prefixMessages);
  const items = records.turnItems ?? [];
  const expectedById = new Map(plan.events.filter((event) => event.type === "message.updated").map((event) => {
    const payload = event.payload as Record<string, any>;
    return [payload.id, payload] as const;
  }));
  let cursor = 0;
  let adopted = 0;
  for (const turn of source.slice(prefixLength)) {
    const sourceMessages = [turn.user, ...turn.assistant];
    const expected = sourceMessages.map((message) => {
      const id = deterministicUuid(`t3-import:v2:message:${plan.thread.sourceKey}:${message.sourceId}`);
      const payload = expectedById.get(id);
      return payload ? { role: payload.role, text: payload.text, attachments: payload.attachments ?? [] } : undefined;
    });
    const actual = suffix.slice(cursor, cursor + expected.length);
    if (actual.length === 0) break;
    if (actual.length !== expected.length || actual.some((item, i) => {
      const candidate = expected[i];
      if (!candidate || item.role !== candidate.role || item.text !== candidate.text) return true;
      const attachments = (item.attachments ?? []).map((attachment: Record<string, unknown>) => ({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes }));
      return JSON.stringify(attachments) !== JSON.stringify(candidate.attachments);
    })) return -1;
    const lastAssistant = actual.at(-1);
    if (!lastAssistant || lastAssistant.role !== "assistant") return -1;
    const terminal = items.find((item) => item.messageId === lastAssistant.id);
    if (terminalStatus(terminal) !== turn.status) return -1;
    cursor += expected.length;
    adopted++;
  }
  return cursor === suffix.length ? adopted : -1;
}

async function inspectV2(paths: TargetPaths, threadId: string): Promise<V2ThreadReply | undefined> {
  const result = await callV2Native(paths, { op: "inspect", threadIds: [threadId] });
  return result.threads?.find((thread) => thread.threadId === threadId);
}

async function buildV2Plan(conversation: CanonicalConversation, paths: TargetPaths): Promise<V2SourcePlan> {
  const source = conversation.threads.find((thread) => thread.currentBranch) ?? conversation.threads[0];
  if (!source) throw safetyError(`Conversation ${conversation.summary.id} has no importable task.`);
  const turns = source.turns.filter(isTerminalTurn);
  const thread = { ...source, turns, ignoredInProgressTurns: source.ignoredInProgressTurns ?? source.turns.filter((turn) => !isTerminalTurn(turn)).length };
  const record = sourceRecord(paths, thread);
  if (!record) return { conversation, thread, status: "not-imported", added: [], adopted: 0, warnings: ["Conversation has not been imported into this T3 database or its source mapping is ambiguous."], resumable: false };
  if (thread.source === "claude" && conversation.summary.branches > 1
    && conversation.threads.filter((candidate) => candidate.currentBranch).length !== 1) {
    return { conversation, thread, record, status: "branch-sync-unsupported", added: [], adopted: 0,
      warnings: [...thread.warnings, "Claude synchronization requires one source-selected branch leaf; the current branch is ambiguous."], resumable: record.resumable };
  }
  const target = await inspectV2(paths, record.threadId);
  if (!target?.exists || !target.records?.thread) return { conversation, thread, record, ...(target ? { target } : {}), status: "target-missing", added: [], adopted: 0, warnings: ["The imported T3 task no longer exists; synchronization left it unchanged."], resumable: record.resumable };
  const projected = target.records.thread;
  const nativeThread = providerThreadFor(target, record.threadId);
  if (projected.id !== record.threadId || projected.projectId !== record.projectId || projected.historyOrigin !== "v1_import" || !nativeThread) {
    return { conversation, thread, record, target, status: "history-diverged", added: [], adopted: 0, warnings: ["The T3 task no longer matches its imported source mapping; synchronization left it unchanged."], resumable: record.resumable };
  }
  const sourceNativeId = thread.source === "claude" ? thread.sourceSessionId : String(thread.resumeCursor?.threadId ?? thread.sourceSessionId);
  const sourceDriver = thread.source === "claude" ? "claudeAgent" : "codex";
  const nativeRef = nativeThread.nativeThreadRef;
  if (nativeThread.driver !== sourceDriver || nativeThread.providerInstanceId !== projected.providerInstanceId
    || (record.resumable
      ? nativeRef?.driver !== sourceDriver || nativeRef.nativeId !== sourceNativeId || nativeRef.strength !== "strong"
      : nativeRef !== null)) {
    return { conversation, thread, record, target, status: "history-diverged", added: [], adopted: 0, warnings: ["The active T3 provider binding no longer matches the imported source session; synchronization left it unchanged."], resumable: record.resumable };
  }
  const oldHead = nativeThread.nativeConversationHeadRef ?? null;
  const currentSourceHead = thread.source === "claude" && record.resumable ? thread.resumeCursor?.resumeSessionAt : undefined;
  if (thread.source === "claude" && record.resumable) {
    const headId = oldHead && oldHead.driver === sourceDriver && oldHead.strength === "strong" ? oldHead.nativeId : undefined;
    const expectedHeads = new Set([record.nativeConversationHeadId, currentSourceHead].filter((value): value is string => Boolean(value)));
    if (!headId || !expectedHeads.has(headId)) return { conversation, thread, record, target, status: "history-diverged", added: [], adopted: 0, warnings: ["The Claude conversation head no longer matches the imported branch; synchronization left it unchanged."], resumable: record.resumable };
  } else if (oldHead !== null) {
    return { conversation, thread, record, target, status: "history-diverged", added: [], adopted: 0, warnings: ["The imported provider binding contains an unexpected conversation head; synchronization left it unchanged."], resumable: record.resumable };
  }
  const checkpointLength = checkpointPrefix(thread, record.checkpoint);
  if (checkpointLength === undefined) return { conversation, thread, record, target, status: "history-diverged", added: [], adopted: 0, warnings: ["Previously imported source history was edited or deleted; synchronization left the T3 task unchanged."], resumable: record.resumable };
  const identityThread = { ...thread, sourceKey: record.identitySeed };
  const nativeProjection = record.checkpoint?.version === 2 ? record.checkpoint.nativeProjection : undefined;
  const plannerOptions = { threadId: record.threadId };
  const fullPlan = planV2Thread({ conversation, resume: record.resumable }, identityThread, paths, record.projectId, false, String(nativeThread.providerInstanceId ?? projected.providerInstanceId), plannerOptions);
  const expectedPrefix = { ...identityThread, turns: thread.turns.slice(0, checkpointLength) };
  const prefixPlan = planV2Thread({ conversation, resume: record.resumable }, expectedPrefix, paths, record.projectId, false, String(nativeThread.providerInstanceId ?? projected.providerInstanceId), plannerOptions);
  if (!historyMatchesPrefix(target, prefixPlan, expectedPrefix.turns, nativeProjection)) return { conversation, thread, record, target, status: "history-diverged", added: [], adopted: 0, warnings: ["T3 history no longer matches the imported source prefix; synchronization left the task unchanged."], resumable: record.resumable };
  const prefixMessageCount = prefixPlan.messages.length;
  const adopted = adoptionCount(target, thread.turns, checkpointLength, prefixMessageCount, fullPlan);
  if (adopted < 0) return { conversation, thread, record, target, status: "history-diverged", added: [], adopted: 0, warnings: ["T3 contains an ambiguous, partial, active, or divergent turn suffix; synchronization left the task unchanged."], resumable: record.resumable };
  const added = thread.turns.slice(checkpointLength + adopted);
  const warnings = [...thread.warnings, ...((thread.ignoredInProgressTurns ?? 0) > 0 ? [`Ignored ${thread.ignoredInProgressTurns} active or indeterminate source turn(s).`] : [])];
  const result: V2SourcePlan = { conversation, thread, record, target, status: added.length || adopted ? "synced" : "up-to-date", added, adopted, warnings, providerThread: nativeThread, resumable: record.resumable, fullPlan,
    ...(typeof oldHead?.nativeId === "string" ? { nativeHeadId: oldHead.nativeId } : {}) };
  if (added.length) {
    const nextThread = { ...identityThread, turns: added };
    const planned = planV2Thread({ conversation, resume: record.resumable }, nextThread, paths, record.projectId, false, String(nativeThread.providerInstanceId ?? projected.providerInstanceId), plannerOptions);
    const historyEvents = planned.events.filter((event) => event.type === "message.updated" || event.type === "turn-item.updated" || event.type === "plan.updated");
    const ordinalBase = Math.max(0, ...(target.records?.turnItems ?? []).map((item) => typeof item.ordinal === "number" ? item.ordinal : 0));
    let ordinal = ordinalBase;
    for (const event of historyEvents) {
      const payload = event.payload as Record<string, unknown>;
      if (event.type === "turn-item.updated" && typeof payload.ordinal === "number") payload.ordinal = ++ordinal;
    }
    const newHead = record.resumable && (thread.ignoredInProgressTurns ?? 0) === 0 && thread.source === "claude" && thread.resumeCursor?.resumeSessionAt
      ? { driver: nativeThread.driver, nativeId: thread.resumeCursor.resumeSessionAt, strength: "strong" }
      : oldHead;
    const binding = { ...nativeThread, nativeConversationHeadRef: newHead, updatedAt: thread.updatedAt };
    const bindingChanged = JSON.stringify(oldHead) !== JSON.stringify(newHead);
    result.nativeHeadId = typeof newHead?.nativeId === "string" ? newHead.nativeId : undefined;
    const bindingEvent = bindingChanged ? [{
      id: deterministicUuid(`t3-import:v2:event:${record.identitySeed}:provider-thread-head:${thread.sourceKey}`),
      type: "provider-thread.updated", threadId: record.threadId, driver: nativeThread.driver,
      providerInstanceId: nativeThread.providerInstanceId, occurredAt: thread.updatedAt, payload: binding,
    }] : [];
    result.events = [...historyEvents, ...bindingEvent];
    result.assets = planned.assets;
    result.warnings.push(...planned.warnings);
    result.status = "synced";
  }
  return result;
}

function itemResult(plan: V2SourcePlan, dryRun: boolean): SyncItemResult {
  return {
    source: plan.thread.source, sourceId: plan.thread.sourceSessionId, sourceKey: plan.thread.sourceKey,
    status: dryRun && plan.status === "synced" ? "dry-run" : plan.status,
    ...(plan.record ? { threadId: plan.record.threadId, projectId: plan.record.projectId } : {}),
    title: plan.thread.title, turnsAdded: plan.added.length, turnsAdopted: plan.adopted,
    events: plan.events?.length ?? 0, attachments: plan.assets?.length ?? 0,
    titleAction: "unchanged", resumable: plan.resumable, warnings: plan.warnings,
  };
}

function aggregate(results: SyncItemResult[], dryRun: boolean): SyncRunResult["status"] {
  if (dryRun && results.some((item) => item.status === "dry-run")) return "dry-run";
  const conflicts = results.some((item) => ["history-diverged", "branch-sync-unsupported", "target-missing", "not-imported"].includes(item.status));
  const synced = results.some((item) => item.status === "synced");
  return conflicts && synced ? "mixed" : conflicts ? "conflict" : synced ? "synced" : "up-to-date";
}

export async function inspectV2ConversationSync(conversation: CanonicalConversation, paths: TargetPaths): Promise<ConversationSyncPreview> {
  const plan = await buildV2Plan(conversation, paths);
  const result = itemResult(plan, false);
  const status: ConversationSyncPreview["status"] = plan.status === "not-imported" ? "new"
    : plan.status === "synced" || plan.status === "dry-run" ? "syncable"
      : plan.status;
  return {
    sourceId: result.sourceId, status,
    newTurns: result.turnsAdded,
    newCompletedTurns: plan.added.filter((turn) => turn.status === "completed").length,
    newInterruptedTurns: plan.added.filter((turn) => turn.status === "interrupted").length,
    newFailedTurns: plan.added.filter((turn) => turn.status === "failed").length,
    ignoredActiveTurns: plan.thread.ignoredInProgressTurns ?? 0,
    adoptedTurns: result.turnsAdopted, titleChanged: false,
    selectable: status === "new" || status === "syncable", previouslyImported: Boolean(plan.record),
    ...(result.threadId ? { threadId: result.threadId } : {}), warnings: result.warnings,
  };
}

export async function syncV2Conversations(selections: Array<{ conversation: CanonicalConversation }>, paths: TargetPaths, options: { dryRun: boolean }): Promise<SyncRunResult> {
  await assertT3Closed(paths);
  const releaseLock = options.dryRun ? () => {} : acquireLock(paths);
  const db = new Database(paths.dbPath, { readonly: options.dryRun, fileMustExist: true });
  let backup: string | null = null;
  let assets: ReturnType<typeof materializeAssets> | undefined;
  try {
    const schema = validateTargetDatabase(db);
    if (schema.profile !== "nightly-v2") throw safetyError("The selected target changed profile during synchronization.");
    const plans: V2SourcePlan[] = [];
    for (const selection of selections) plans.push(await buildV2Plan(selection.conversation, paths));
    const results = plans.map((plan) => itemResult(plan, options.dryRun));
    if (options.dryRun) return { schemaVersion: 1, status: aggregate(results, true), target: paths.dbPath, migration: schema.migration, backup: null, results, warnings: [], hasConflicts: results.some((item) => ["history-diverged", "branch-sync-unsupported", "target-missing", "not-imported"].includes(item.status)) };
    const writable = plans.filter((plan) => plan.status === "synced" && (plan.events?.length || plan.adopted));
    if (!writable.length) return { schemaVersion: 1, status: aggregate(results, false), target: paths.dbPath, migration: schema.migration, backup: null, results, warnings: [], hasConflicts: plans.some((plan) => ["history-diverged", "branch-sync-unsupported", "target-missing", "not-imported"].includes(plan.status)) };
    const eventCount = writable.reduce((sum, plan) => sum + (plan.events?.length ?? 0), 0);
    if (eventCount > 900) throw safetyError(`Synchronization would append ${eventCount} events, exceeding the safe one-launch limit. Sync fewer conversations at a time.`);
    if (eventCount > 0) backup = createBackup(db, paths);
    if (db.open) db.close();
    const eventPlans = writable.filter((plan) => plan.events?.length);
    assets = eventPlans.length ? materializeAssets(eventPlans.map((plan) => ({ assets: plan.assets ?? [] })), paths, randomUUID()) : undefined;
    const ledger: LedgerRecord[] = [];
    for (const plan of writable) {
      const record = plan.record!;
      let projectedAfterWrite = plan.target?.records;
      let lastSequence = record.lastSequence;
      let firstSequence = record.lastSequence + 1;
      if (plan.events?.length) {
        const binding = plan.providerThread!;
        const head = binding.nativeConversationHeadRef ?? null;
        const result = await callV2Native(paths, {
          op: "append", threadId: record.threadId, projectId: record.projectId,
          providerInstanceId: binding.providerInstanceId, providerThreadId: binding.id,
          driver: binding.driver, nativeThreadRef: binding.nativeThreadRef,
          expectedConversationHeadRef: head, events: plan.events,
        });
        const readback = result.projections?.find((thread) => thread.threadId === record.threadId);
        const readbackThread = readback?.records?.thread ?? readback?.snapshot?.records?.thread;
        const expectedHead = plan.events.find((event) => event.type === "provider-thread.updated")?.payload as Record<string, any> | undefined;
        const actualBinding = readback ? providerThreadFor(readback, record.threadId) : undefined;
        const verified = {
          exists: readbackThread?.id === record.threadId,
          project: readbackThread?.projectId === record.projectId,
          activeProvider: readbackThread?.activeProviderThreadId === binding.id,
          providerBinding: Boolean(actualBinding && JSON.stringify(actualBinding.nativeThreadRef ?? null) === JSON.stringify(binding.nativeThreadRef ?? null)),
          conversationHead: Boolean(actualBinding && JSON.stringify(actualBinding.nativeConversationHeadRef ?? null) === JSON.stringify(expectedHead?.nativeConversationHeadRef ?? binding.nativeConversationHeadRef ?? null)),
          history: Boolean(readback && plan.fullPlan && historyMatchesPrefix(readback, plan.fullPlan, plan.thread.turns,
            record.checkpoint?.version === 2 ? record.checkpoint.nativeProjection : undefined)),
        };
        if (Object.values(verified).some((value) => !value)) {
          throw safetyError(`T3 v2 append could not be verified for ${plan.thread.sourceSessionId} (exists=${verified.exists}, project=${verified.project}, activeProvider=${verified.activeProvider}, providerBinding=${verified.providerBinding}, conversationHead=${verified.conversationHead}, history=${verified.history}); the verified backup is ${backup ?? record.backupPath}.`);
        }
        projectedAfterWrite = readback?.records ?? readback?.snapshot?.records ?? projectedAfterWrite;
        firstSequence = result.storedSequenceRange?.first ?? firstSequence;
        lastSequence = result.storedSequenceRange?.last ?? record.lastSequence;
      }
      const checkpoint = checkpointForThread(plan.thread);
      if (record.checkpoint?.version === 2 && record.checkpoint.nativeProjection) {
        const identity = captureNativeProjectionIdentity(projectedAfterWrite);
        if (!identity) throw safetyError(`T3 did not return projected native history identities for ${plan.thread.sourceSessionId}; the verified backup is ${backup ?? record.backupPath}.`);
        checkpoint.nativeProjection = identity;
      }
      ledger.push({ ...record, sourceFingerprint: plan.conversation.fingerprint, currentSourceKey: plan.thread.sourceKey,
        ...(plan.thread.leafId ? { sourceLeafId: plan.thread.leafId } : {}), sourceTitle: plan.thread.title,
        ...(plan.thread.source === "claude" && plan.resumable && plan.nativeHeadId ? { nativeConversationHeadId: plan.nativeHeadId } : {}),
        checkpoint, syncedAt: new Date().toISOString(), migration: schema.migration,
        lastSequence, backupPath: backup ?? record.backupPath, warnings: plan.warnings, isCanonical: true });
      const result = results[plans.indexOf(plan)]!;
      if (plan.events?.length && lastSequence > record.lastSequence) result.sequence = { first: firstSequence, last: lastSequence };
    }
    assets?.cleanup();
    recordImports(ledger);
    const verificationDb = new Database(paths.dbPath, { readonly: true, fileMustExist: true });
    let integrity: string;
    try { integrity = String(verificationDb.pragma("integrity_check", { simple: true })); }
    finally { verificationDb.close(); }
    if (integrity !== "ok") throw safetyError(`Post-sync integrity check failed: ${integrity}`);
    return { schemaVersion: 1, status: aggregate(results, false), target: paths.dbPath, migration: schema.migration, backup, results, warnings: [], hasConflicts: plans.some((plan) => ["history-diverged", "branch-sync-unsupported", "target-missing", "not-imported"].includes(plan.status)) };
  } finally {
    if (db.open) db.close();
    assets?.cleanup();
    releaseLock();
  }
}
