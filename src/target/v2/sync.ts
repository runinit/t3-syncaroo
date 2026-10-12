import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { CanonicalConversation, CanonicalThread, ConversationSyncPreview, SyncItemResult, SyncRunResult, TargetPaths } from "../../core/types.js";
import { isTerminalTurn } from "../../core/types.js";
import { checkpointForThread, legacyTurnSemanticHash, turnSemanticHash, type ImportCheckpoint, type ImportCheckpointV1, type ImportCheckpointV2, type NativeProjectionIdentityV1 } from "../../core/checkpoint.js";
import { canonicalPath, deterministicUuid, sha256 } from "../../core/util.js";
import { safetyError } from "../../core/errors.js";
import { acquireLock, callV2Native, createBackup, materializeAssets, planV2Thread, type V2ThreadReply } from "../importer.js";
import { captureNativeProjectionIdentity, projectedHistoryMatches, nativeProjectionIdentityMatches } from "./history.js";
import { reconcileNativeHistory, nativeExpectedTurnEvents } from "./native-history.js";
import { verifyUpgradedPrefix } from "./upgraded-binding.js";
import { verifyOrRecoverV2Assets } from "./assets.js";
import { assertT3Closed, validateTargetDatabase } from "../schema.js";
import { listImports, listImportsForTargets, recordImports, type LedgerRecord, type StoredLedgerRecord } from "../ledger.js";

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
  recoveredNativeIdentity?: boolean;
  upgraded?: { prefixPlan: ReturnType<typeof planV2Thread>; expectedSnapshot: Record<string, unknown>; event?: Record<string, unknown> };
  fullPlan?: ReturnType<typeof planV2Thread>;
}

function targetId(paths: TargetPaths): string { return sha256(canonicalPath(paths.dbPath)); }

function nativeSequenceRange(target: V2ThreadReply | undefined): { first: number; last: number } | undefined {
  const sequences = target?.events?.map((event) => event.sequence)
    .filter((sequence) => Number.isSafeInteger(sequence) && sequence > 0) ?? [];
  if (!sequences.length) return undefined;
  return { first: Math.min(...sequences), last: Math.max(...sequences) };
}

function sourceRecord(paths: TargetPaths, thread: CanonicalThread): { record?: StoredLedgerRecord; ambiguous: boolean } {
  const currentTargetId = targetId(paths);
  const targetIds = [currentTargetId];
  if (basename(paths.dbPath) === "statev2.sqlite") targetIds.push(sha256(canonicalPath(join(paths.stateDir, "state.sqlite"))));
  const rows = listImportsForTargets(targetIds, thread.source)
    .filter((row) => row.sourceSessionId === thread.sourceSessionId && row.isCanonical !== false && !row.supersededByThreadId);
  const pick = (candidates: StoredLedgerRecord[]) => {
    const current = candidates.filter((row) => row.sourceKey === thread.sourceKey || row.currentSourceKey === thread.sourceKey);
    if (current.length === 1) return { record: current[0]!, ambiguous: false };
    if (current.length > 1) return { ambiguous: true };
    const resumable = candidates.filter((row) => row.resumable);
    if (resumable.length === 1) return { record: resumable[0]!, ambiguous: false };
    if (resumable.length > 1 || candidates.length > 1) return { ambiguous: true };
    return candidates.length === 1 ? { record: candidates[0]!, ambiguous: false } : { ambiguous: false };
  };
  const currentRows = rows.filter((row) => row.targetId === currentTargetId);
  const selected = pick(currentRows.length ? currentRows : rows.filter((row) => row.targetId !== currentTargetId));
  return selected;
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

function historyMatchesPrefix(
  target: V2ThreadReply,
  plan: ReturnType<typeof planV2Thread>,
  turns: CanonicalThread["turns"],
  nativeProjection?: NativeProjectionIdentityV1,
  sourceThread?: CanonicalThread,
  nativeThread?: Record<string, any>,
): boolean {
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
      providerTurns: (records.providerTurns ?? []).slice(0, nativeProjection.providerTurns?.length ?? 0),
    }, nativeProjection)) return false;
    const nativeProviderPrefix = records.providerTurns?.slice(0, nativeProjection.providerTurns?.length ?? 0) ?? [];
    if (nativeProviderPrefix.length > 0) {
      if (!sourceThread || !nativeThread || !nativeProjection.providerTurns
        || !nativeProviderTurnsMatchSourcePrefix(nativeProviderPrefix, sourceThread.turns.slice(0, turns.length), nativeThread)) return false;
    } else if (nativeProjection.providerTurns === undefined && (records.providerTurns ?? []).length > 0) return false;
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
    if (!projectedHistoryMatches(prefixRecords, expected, { identity: "native-semantic" })) return false;
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

function nativeProviderTurnsMatchSourcePrefix(
  providerTurns: Array<Record<string, any>>,
  sourceTurns: CanonicalThread["turns"],
  providerThread: Record<string, any>,
): boolean {
  const driver = providerThread.driver;
  if (driver !== "codex" && driver !== "claudeAgent") return false;
  const sourceOrder: number[] = [];
  for (const providerTurn of providerTurns) {
    const native = providerTurn.nativeTurnRef as Record<string, any> | undefined;
    const matches = sourceTurns.flatMap((turn, index) => {
      const assistantNodeIds = turn.assistant.flatMap((message) => {
        const match = /^(.*):text:\d+$/u.exec(message.sourceId);
        return match?.[1] ? [match[1]] : [];
      });
      const nativeIds = driver === "codex" ? [turn.id] : assistantNodeIds.slice(-1);
      return native && native.driver === driver && nativeIds.includes(String(native.nativeId))
        && (driver === "codex" ? native.strength === "strong" : (native.strength === "weak" || native.strength === "strong"))
        && providerTurn.providerThreadId === providerThread.id
        && providerTurn.status === turn.status
        && !(driver === "claudeAgent" && String(native.nativeId).startsWith("turn:"))
        ? [{ index }] : [];
    });
    if (matches.length !== 1) return false;
    sourceOrder.push(matches[0]!.index);
  }
  return sourceOrder.every((index, offset) => offset === 0 || index > sourceOrder[offset - 1]!);
}

function nativeContinuationCount(
  target: V2ThreadReply,
  records: NonNullable<V2ThreadReply["records"]>,
  suffixMessages: number,
  suffixItems: number,
  suffixPlans: number,
  sourceTurns: CanonicalThread["turns"],
  suffixPlansByTurn: Array<ReturnType<typeof planV2Thread>>,
  driver: "codex" | "claudeAgent",
  providerThread: Record<string, any>,
  sourceThread: CanonicalThread,
  verifiedPrefixTurns: CanonicalThread["turns"],
  previouslyVerifiedHead?: string,
  verifiedProviderTurnIds?: string[],
): number {
  if (driver === "claudeAgent" && !sourceThread.currentBranch) return -1;
  if (driver === "claudeAgent") {
    const expectedHead = sourceThread.resumeCursor?.resumeSessionAt;
    const nativeHead = providerThread.nativeConversationHeadRef;
    // Completed Claude adapter runs clear the head. A null head is safe only
    // alongside the complete, per-turn/node/item lineage proof below.
    const trustedHeads = new Set([expectedHead, previouslyVerifiedHead].filter((value): value is string => Boolean(value)));
    if (typeof expectedHead !== "string" || !expectedHead || (nativeHead !== null
      && (nativeHead?.driver !== driver || nativeHead.strength !== "strong" || !trustedHeads.has(nativeHead.nativeId)))) return -1;
  }
  const allTurns = records.providerTurns as Array<Record<string, any>> | undefined;
  if (!Array.isArray(allTurns) || sourceTurns.length !== suffixPlansByTurn.length) return -1;
  const previousIds = verifiedProviderTurnIds ?? [];
  if (allTurns.length !== previousIds.length + sourceTurns.length
    || !previousIds.every((id, index) => allTurns[index]?.id === id)) return -1;
  const previousTurns = allTurns.slice(0, previousIds.length);
  const turns = allTurns.slice(previousIds.length);
  const matchSourceTurn = (nativeTurn: Record<string, any>, sourceTurn: CanonicalThread["turns"][number]): boolean => {
    const assistantNodeIds = sourceTurn.assistant.flatMap((message) => {
      const match = /^(.*):text:\d+$/u.exec(message.sourceId);
      return match?.[1] ? [match[1]] : [];
    });
    const nativeIds = driver === "codex" ? [sourceTurn.id] : assistantNodeIds.slice(-1);
    const matches = allTurns.filter((turn) => {
      const native = turn.nativeTurnRef as Record<string, any> | undefined;
      return native?.driver === driver && typeof native.nativeId === "string" && native.strength !== undefined
        && nativeIds.includes(native.nativeId) && native.nativeId !== ""
        && !(driver === "codex" && native.strength !== "strong")
        && !(driver === "claudeAgent" && native.strength !== "weak" && native.strength !== "strong");
    });
    if (matches.length !== 1 || matches[0] !== nativeTurn || nativeTurn.providerThreadId !== providerThread.id) return false;
    const expectedStatus = sourceTurn.status === "completed" ? "completed" : sourceTurn.status;
    if (nativeTurn.status !== expectedStatus) return false;
    return !(driver === "claudeAgent" && String(nativeTurn.nativeTurnRef?.nativeId).startsWith("turn:"));
  };
  const sourceOrder = new Map(sourceThread.turns.map((turn, index) => [turn, index]));
  const matchedSourceOrder: number[] = [];
  for (let index = 0; index < previousTurns.length; index++) {
    const nativeTurn = previousTurns[index]!;
    const matches = verifiedPrefixTurns.filter((sourceTurn) => matchSourceTurn(nativeTurn, sourceTurn));
    if (matches.length !== 1) return -1;
    const order = sourceOrder.get(matches[0]!);
    if (order === undefined) return -1;
    matchedSourceOrder.push(order);
  }
  for (let index = 0; index < sourceTurns.length; index++) {
    if (!matchSourceTurn(turns[index]!, sourceTurns[index]!)) return -1;
    const order = sourceOrder.get(sourceTurns[index]!);
    if (order === undefined) return -1;
    matchedSourceOrder.push(order);
  }
  if (matchedSourceOrder.some((order, index) => index > 0 && order <= matchedSourceOrder[index - 1]!)) return -1;

  const actualMessages = records.messages ?? [];
  const actualItems = records.turnItems ?? [];
  const actualPlans = records.plans ?? [];
  const suffixMessageRows = actualMessages.slice(suffixMessages);
  const suffixItemRows = actualItems.slice(suffixItems);
  const messageIds = new Set(suffixMessageRows.map((message) => message.id));
  const itemIds = new Set(suffixItemRows.map((item) => item.id));
  if (suffixMessageRows.some((message) => typeof message.id !== "string" || !message.id)
    || suffixItemRows.some((item) => typeof item.id !== "string" || !item.id)) return -1;
  if (messageIds.size !== actualMessages.length - suffixMessages || itemIds.size !== actualItems.length - suffixItems) return -1;
  let messageOffset = suffixMessages;
  let itemOffset = suffixItems;
  let planOffset = suffixPlans;
  for (let turnIndex = 0; turnIndex < sourceTurns.length; turnIndex++) {
    const turn = sourceTurns[turnIndex]!;
    const turnPlan = suffixPlansByTurn[turnIndex]!;
    const messagesExpected = turnPlan.events.filter((event) => event.type === "message.updated").length;
    const itemsExpected = turnPlan.events.filter((event) => event.type === "turn-item.updated").length;
    const plansExpected = turnPlan.events.filter((event) => event.type === "plan.updated").length;
    const projection = {
      messages: actualMessages.slice(messageOffset, messageOffset + messagesExpected),
      turnItems: actualItems.slice(itemOffset, itemOffset + itemsExpected),
      plans: actualPlans.slice(planOffset, planOffset + plansExpected),
    };
    const normalized = nativeExpectedTurnEvents(turnPlan, turn, driver);
    if (!projectedHistoryMatches(projection, normalized.events, { identity: "native-semantic" })) return -1;
    const providerTurnId = turns[turnIndex]?.id;
    if (!providerTurnId) return -1;
    const actualTurnMessages = projection.messages;
    for (let index = 0; index < projection.turnItems.length; index++) {
      const item = projection.turnItems[index]!;
      const expected = normalized.events.filter((event) => event.type === "turn-item.updated")[index]?.payload as Record<string, any> | undefined;
      if (!expected) return -1;
      const userMessage = expected.type === "user_message";
      if (userMessage) {
        if (item.providerTurnId !== null && item.providerTurnId !== undefined && item.providerTurnId !== providerTurnId) return -1;
      } else if (item.providerTurnId !== providerTurnId) return -1;
      if (item.providerThreadId !== null && item.providerThreadId !== undefined && item.providerThreadId !== providerThread.id) return -1;
      if (typeof expected.messageId === "string") {
        const expectedMessageIndex = normalized.events.filter((event) => event.type === "message.updated")
          .findIndex((event) => (event.payload as Record<string, any>).id === expected.messageId);
        if (expectedMessageIndex < 0 || item.messageId !== actualTurnMessages[expectedMessageIndex]?.id) return -1;
        const sourceNativeId = normalized.messageNativeIds.get(expected.messageId);
        if (sourceNativeId && item.nativeItemRef !== null && item.nativeItemRef !== undefined) {
          const nativeItem = item.nativeItemRef as Record<string, any> | null | undefined;
          if (nativeItem?.driver !== driver || nativeItem.strength !== "strong" || nativeItem.nativeId !== sourceNativeId) return -1;
        }
      } else if (item.messageId !== null && item.messageId !== undefined
        && (typeof item.messageId !== "string" || !messageIds.has(item.messageId))) return -1;
    }
    messageOffset += messagesExpected;
    itemOffset += itemsExpected;
    planOffset += plansExpected;
  }
  return messageOffset === actualMessages.length && itemOffset === actualItems.length && planOffset === actualPlans.length
    ? sourceTurns.length
    : -1;
}


function adoptionCount(
  target: V2ThreadReply,
  prefixMessages: number,
  prefixItems: number,
  prefixPlans: number,
  plan: ReturnType<typeof planV2Thread>,
  sourceThread: CanonicalThread,
  prefixTurns: CanonicalThread["turns"],
  sourceTurns: CanonicalThread["turns"],
  suffixPlansByTurn: Array<ReturnType<typeof planV2Thread>>,
  providerThread: Record<string, any>,
  record: StoredLedgerRecord,
): number {
  const records = recordsOf(target);
  const expectedMessages = plan.events.filter((event) => event.type === "message.updated");
  const expectedItems = plan.events.filter((event) => event.type === "turn-item.updated");
  const expectedPlans = plan.events.filter((event) => event.type === "plan.updated");
  const actualMessages = records.messages ?? [];
  const actualItems = records.turnItems ?? [];
  const actualPlans = records.plans ?? [];
  const suffixRecords = {
    messages: actualMessages.slice(prefixMessages),
    turnItems: actualItems.slice(prefixItems),
    plans: actualPlans.slice(prefixPlans),
  };
  if (suffixRecords.messages.length === 0) {
    const expectedProviderTurnCount = record.checkpoint?.version === 2
      ? record.checkpoint.nativeProjection?.providerTurns?.length ?? 0
      : 0;
    const actualProviderTurnCount = Array.isArray(records.providerTurns) ? records.providerTurns.length : 0;
    return suffixRecords.turnItems.length === 0 && suffixRecords.plans.length === 0
      && actualProviderTurnCount === expectedProviderTurnCount ? 0 : -1;
  }
  if (suffixRecords.messages.length !== expectedMessages.length
    || suffixRecords.turnItems.length !== expectedItems.length
    || suffixRecords.plans.length !== expectedPlans.length) return -1;
  if (projectedHistoryMatches(suffixRecords, plan.events, { identity: "exact" })) {
    const ownedEvents = new Set((target.events ?? []).map((event) => event.id));
    if (Array.isArray(target.events) && plan.events.filter((event) => ["message.updated", "turn-item.updated", "plan.updated"].includes(String(event.type)))
      .every((event) => ownedEvents.has(String(event.id)))) return plan.thread.turns.length;
  }
  const source = plan.thread.source;
  if (source !== "codex" && source !== "claude") return -1;
  const provider = providerThreadFor(target, plan.threadId);
  const driver = source === "codex" ? "codex" : "claudeAgent";
  if (!provider || provider.driver !== driver || provider.providerInstanceId !== plan.provider.instanceId) return -1;
  return nativeContinuationCount(target, records, prefixMessages, prefixItems, prefixPlans, sourceTurns, suffixPlansByTurn, driver, provider, sourceThread,
    prefixTurns, record.nativeConversationHeadId, record.checkpoint?.version === 2 ? record.checkpoint.nativeProjection?.providerTurns : undefined);
}

async function inspectV2(paths: TargetPaths, threadId: string): Promise<V2ThreadReply | undefined> {
  const result = await callV2Native(paths, { op: "inspect", threadIds: [threadId], includeRecoveryRecords: true });
  return result.threads?.find((thread) => thread.threadId === threadId);
}

async function buildV2Plan(conversation: CanonicalConversation, paths: TargetPaths): Promise<V2SourcePlan> {
  const source = conversation.threads.find((thread) => thread.currentBranch) ?? conversation.threads[0];
  if (!source) throw safetyError(`Conversation ${conversation.summary.id} has no importable task.`);
  const turns = source.turns.filter(isTerminalTurn);
  const thread = { ...source, turns, ignoredInProgressTurns: source.ignoredInProgressTurns ?? source.turns.filter((turn) => !isTerminalTurn(turn)).length };
  const mapping = sourceRecord(paths, thread);
  let record = mapping.record;
  if (!record) return { conversation, thread, status: mapping.ambiguous ? "history-diverged" : "not-imported", added: [], adopted: 0,
    warnings: [mapping.ambiguous ? "More than one active source mapping exists for this task. Preserve the existing tasks and resolve the mapping before synchronization." : "Conversation has not been imported into this T3 database."], resumable: false };
  if (thread.source === "claude" && conversation.summary.branches > 1
    && conversation.threads.filter((candidate) => candidate.currentBranch).length !== 1) {
    return { conversation, thread, record, status: "branch-sync-unsupported", added: [], adopted: 0,
      warnings: [...thread.warnings, "Claude synchronization requires one source-selected branch leaf; the current branch is ambiguous."], resumable: record.resumable };
  }
  let target = await inspectV2(paths, record.threadId);
  if (!target?.exists || !target.records?.thread) return { conversation, thread, record, ...(target ? { target } : {}), status: "target-missing", added: [], adopted: 0, warnings: ["The imported T3 task no longer exists; synchronization left it unchanged."], resumable: record.resumable };
  let upgraded: V2SourcePlan["upgraded"];
  if (!(record.checkpoint?.version === 2 && record.checkpoint.nativeProjection)
    && (record.targetId !== targetId(paths) || !providerThreadFor(target, record.threadId))) {
    const savedRecord = record;
    const providerInstanceId = String(target.thread?.providerInstanceId ?? "");
    const proof = verifyUpgradedPrefix({ sourceThread: thread, target,
      expected: {
        threadId: record.threadId, projectId: record.projectId, providerInstanceId,
        sourceSessionId: record.sourceSessionId,
        nativeThreadId: thread.source === "claude" ? thread.sourceSessionId : String(thread.resumeCursor?.threadId ?? thread.sourceSessionId),
        sourceFingerprint: record.sourceFingerprint, currentFingerprint: conversation.fingerprint,
        identitySeed: record.identitySeed, resumable: record.resumable,
        ...(record.checkpoint ? { checkpoint: record.checkpoint } : {}),
        ...(record.nativeConversationHeadId ? { nativeConversationHeadId: record.nativeConversationHeadId } : {}),
      },
      planPrefix: (prefix) => planV2Thread({ conversation, resume: savedRecord.resumable }, prefix, paths,
        savedRecord.projectId, false, providerInstanceId,
        { threadId: savedRecord.threadId, identitySeed: savedRecord.identitySeed, disableResume: !savedRecord.resumable }),
    });
    if (proof.status === "conflict") return { conversation, thread, record, target, status: "history-diverged",
      added: [], adopted: 0, warnings: [proof.reason], resumable: record.resumable };
    const nativeProjection = captureNativeProjectionIdentity(target.records);
    if (!nativeProjection) return { conversation, thread, record, target, status: "history-diverged",
      added: [], adopted: 0, warnings: ["The converted task's native history identities cannot be verified."], resumable: record.resumable };
    record = { ...record, checkpoint: { ...checkpointForThread(proof.prefixThread), nativeProjection } };
    upgraded = { prefixPlan: proof.prefixPlan, expectedSnapshot: proof.expectedSnapshot };
    if (proof.binding === "absent") {
      const event = proof.prefixPlan.events.find((entry) => entry.type === "provider-thread.updated");
      if (!event) throw safetyError("The verified converted prefix has no provider binding to restore.");
      upgraded.event = event;
      const binding = event.payload as NonNullable<NonNullable<V2ThreadReply["records"]>["providerThreads"]>[number];
      target = { ...target, thread: { ...target.thread, activeProviderThreadId: binding.id },
        records: { ...target.records, thread: { ...target.records.thread, activeProviderThreadId: binding.id }, providerThreads: [binding] } };
    }
  }
  const projected = target.records?.thread;
  const nativeThread = providerThreadFor(target, record.threadId);
  if (!projected || projected.id !== record.threadId || projected.projectId !== record.projectId || projected.historyOrigin !== "v1_import" || !nativeThread) {
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
    if (oldHead !== null && (!headId || !expectedHeads.has(headId))) return { conversation, thread, record, target, status: "history-diverged", added: [], adopted: 0, warnings: ["The Claude conversation head no longer matches the imported branch; synchronization left it unchanged."], resumable: record.resumable };
  } else if (oldHead !== null) {
    return { conversation, thread, record, target, status: "history-diverged", added: [], adopted: 0, warnings: ["The imported provider binding contains an unexpected conversation head; synchronization left it unchanged."], resumable: record.resumable };
  }
  const checkpointLength = checkpointPrefix(thread, record.checkpoint);
  if (checkpointLength === undefined) return { conversation, thread, record, target, status: "history-diverged", added: [], adopted: 0, warnings: ["Previously imported source history was edited or deleted; synchronization left the T3 task unchanged."], resumable: record.resumable };
  const identityThread = { ...thread, sourceKey: record.identitySeed };
  let nativeProjection = record.checkpoint?.version === 2 ? record.checkpoint.nativeProjection : undefined;
  const plannerOptions = { threadId: record.threadId };
  const fullPlan = planV2Thread({ conversation, resume: record.resumable }, identityThread, paths, record.projectId, false, String(nativeThread.providerInstanceId ?? projected.providerInstanceId), plannerOptions);
  const expectedPrefix = { ...identityThread, turns: thread.turns.slice(0, checkpointLength) };
  const prefixPlan = planV2Thread({ conversation, resume: record.resumable }, expectedPrefix, paths, record.projectId, false, String(nativeThread.providerInstanceId ?? projected.providerInstanceId), plannerOptions);
  const normalizationRecord = record;
  let recoveredNativeIdentity = false;
  const normalizedTurns = identityThread.turns.map((turn) => nativeExpectedTurnEvents(
    planV2Thread({ conversation, resume: normalizationRecord.resumable }, { ...identityThread, turns: [turn] }, paths,
      normalizationRecord.projectId, false, String(nativeThread.providerInstanceId), plannerOptions), turn, sourceDriver).events);
  const nativeHistory = reconcileNativeHistory(target, identityThread, nativeThread, normalizedTurns);
  target = nativeHistory.target;
  // Older sync versions could save source checkpoints after native adoption
  // without retaining the native row identities. Recover only after a complete
  // source/native proof, retaining exact IDs for the importer-owned rows.
  if (!nativeProjection && nativeHistory.verified) {
    const prefixRecords = {
      messages: (target.records?.messages ?? []).slice(0, prefixPlan.messages.length),
      turnItems: (target.records?.turnItems ?? []).slice(0, prefixPlan.events.filter((event) => event.type === "turn-item.updated").length),
      plans: (target.records?.plans ?? []).slice(0, prefixPlan.events.filter((event) => event.type === "plan.updated").length),
      providerTurns: (target.records?.providerTurns ?? []).filter((providerTurn) =>
        nativeProviderTurnsMatchSourcePrefix([providerTurn], expectedPrefix.turns, nativeThread)),
    };
    const expectedMessages = prefixPlan.events.filter((event) => event.type === "message.updated").map((event) => event.payload as Record<string, any>);
    const importedIdsMatch = (prefixRecords.messages ?? []).every((message, index) => {
      const item = prefixRecords.turnItems?.find((item) => item.messageId === message.id);
      return item?.providerThreadId === nativeThread.id || message.id === expectedMessages[index]?.id;
    });
    if (importedIdsMatch && projectedHistoryMatches(prefixRecords, prefixPlan.events, { identity: "native-semantic" })) {
      nativeProjection = captureNativeProjectionIdentity(prefixRecords);
      if (nativeProjection) {
        record = { ...record, checkpoint: { ...checkpointForThread(expectedPrefix), nativeProjection } };
        recoveredNativeIdentity = true;
      }
    }
  }
  if (!historyMatchesPrefix(target, prefixPlan, expectedPrefix.turns, nativeProjection, thread, nativeThread)) return { conversation, thread, record, target, status: "history-diverged", added: [], adopted: 0, warnings: ["T3 history no longer matches the imported source prefix; synchronization left the task unchanged."], resumable: record.resumable };
  const prefixMessageCount = prefixPlan.messages.length;
  const prefixItemCount = prefixPlan.events.filter((event) => event.type === "turn-item.updated").length;
  const prefixPlanCount = prefixPlan.events.filter((event) => event.type === "plan.updated").length;
  const suffixTurns = thread.turns.slice(checkpointLength);
  const suffixPlan = suffixTurns.length
    ? planV2Thread({ conversation, resume: record.resumable }, { ...identityThread, turns: suffixTurns }, paths, record.projectId, false, String(nativeThread.providerInstanceId ?? projected.providerInstanceId), plannerOptions)
    : { ...prefixPlan, thread: { ...identityThread, turns: [] }, events: [], messages: [] };
  const suffixPlansByTurn = suffixTurns.map((turn) => planV2Thread({ conversation, resume: record.resumable }, { ...identityThread, turns: [turn] }, paths, record.projectId, false, String(nativeThread.providerInstanceId ?? projected.providerInstanceId), plannerOptions));
  const adopted = adoptionCount(target, prefixMessageCount, prefixItemCount, prefixPlanCount, suffixPlan,
    thread, thread.turns.slice(0, checkpointLength), suffixTurns, suffixPlansByTurn, nativeThread, record);
  if (adopted < 0) return { conversation, thread, record, target, status: "history-diverged", added: [], adopted: 0, warnings: ["T3 contains an ambiguous, partial, active, or divergent turn suffix; synchronization left the task unchanged."], resumable: record.resumable };
  const added = thread.turns.slice(checkpointLength + adopted);
  const warnings = [...thread.warnings, ...((thread.ignoredInProgressTurns ?? 0) > 0 ? [`Ignored ${thread.ignoredInProgressTurns} active or indeterminate source turn(s).`] : [])];
  const result: V2SourcePlan = { conversation, thread, record, target, status: added.length || adopted || upgraded || recoveredNativeIdentity || nativeHistory.supplementalEvents.length ? "synced" : "up-to-date", added, adopted, warnings, providerThread: nativeThread, resumable: record.resumable, fullPlan, recoveredNativeIdentity, ...(upgraded ? { upgraded } : {}),
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
  if (nativeHistory.supplementalEvents.length) {
    const ordinalBase = Math.max(0, ...(target.records?.turnItems ?? []).map((item) => typeof item.ordinal === "number" ? item.ordinal : 0));
    nativeHistory.supplementalEvents.forEach((event, index) => { (event.payload as Record<string, unknown>).ordinal = ordinalBase + index + 1; });
    result.events = [...nativeHistory.supplementalEvents, ...(result.events ?? [])];
  }
  return result;
}

function itemResult(plan: V2SourcePlan, dryRun: boolean): SyncItemResult {
  return {
    source: plan.thread.source, sourceId: plan.thread.sourceSessionId, sourceKey: plan.thread.sourceKey,
    status: dryRun && plan.status === "synced" ? "dry-run" : plan.status,
    ...(plan.record ? { threadId: plan.record.threadId, projectId: plan.record.projectId } : {}),
    title: plan.thread.title, turnsAdded: plan.added.length, turnsAdopted: plan.adopted,
    events: (plan.events?.length ?? 0) + (plan.upgraded?.event ? 1 : 0), attachments: plan.assets?.length ?? 0,
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
    const writable = plans.filter((plan) => plan.status === "synced" && (plan.events?.length || plan.adopted || plan.upgraded || plan.recoveredNativeIdentity));
    if (!writable.length) return { schemaVersion: 1, status: aggregate(results, false), target: paths.dbPath, migration: schema.migration, backup: null, results, warnings: [], hasConflicts: plans.some((plan) => ["history-diverged", "branch-sync-unsupported", "target-missing", "not-imported"].includes(plan.status)) };
    const eventCount = writable.reduce((sum, plan) => sum + (plan.events?.length ?? 0) + (plan.upgraded?.event ? 1 : 0), 0);
    if (eventCount > 900) throw safetyError(`Synchronization would append ${eventCount} events, exceeding the safe one-launch limit. Sync fewer conversations at a time.`);
    if (eventCount > 0) backup = createBackup(db, paths);
    if (db.open) db.close();
    const eventPlans = writable.filter((plan) => plan.events?.length);
    assets = eventPlans.length ? materializeAssets(eventPlans.map((plan) => ({ assets: plan.assets ?? [] })), paths, randomUUID()) : undefined;
    const ledger: LedgerRecord[] = [];
    for (const plan of writable) {
      const record = plan.record!;
      if (plan.upgraded) {
        verifyOrRecoverV2Assets(plan.upgraded.prefixPlan, paths, true, materializeAssets);
        if (plan.upgraded.event) {
          const attached = await callV2Native(paths, { op: "attach-upgraded-binding",
            threadId: record.threadId, projectId: record.projectId,
            providerInstanceId: plan.providerThread!.providerInstanceId,
            expectedSnapshot: plan.upgraded.expectedSnapshot, event: plan.upgraded.event });
          if (!attached.ok || (attached.outcome !== "attached" && attached.outcome !== "already-attached")) {
            plan.status = "history-diverged";
            plan.warnings.push(`The converted binding changed before synchronization (${attached.reason ?? attached.error ?? "native attach conflict"}).`);
            results[plans.indexOf(plan)] = itemResult(plan, false);
            continue;
          }
          const refreshed = await inspectV2(paths, record.threadId);
          if (!refreshed?.exists) throw safetyError("The converted task disappeared after binding restoration.");
          plan.target = refreshed;
        }
      }
      let projectedAfterWrite = plan.target?.records;
      const migratedRange = record.targetId === targetId(paths) ? undefined : nativeSequenceRange(plan.target);
      let lastSequence = migratedRange?.last ?? record.lastSequence;
      let firstSequence = migratedRange?.first ?? record.lastSequence + 1;
      if (plan.events?.length) {
        const binding = plan.providerThread!;
        const head = binding.nativeConversationHeadRef ?? null;
        const result = await callV2Native(paths, {
          op: "append", threadId: record.threadId, projectId: record.projectId,
          providerInstanceId: binding.providerInstanceId, providerThreadId: binding.id,
          driver: binding.driver, nativeThreadRef: binding.nativeThreadRef,
          expectedConversationHeadRef: head, events: plan.events,
        });
        let readback: V2ThreadReply | undefined = result.projections?.find((thread) => thread.threadId === record.threadId);
        if (readback && (readback.records?.providerTurns?.length ?? 0) > 0) {
          const inspected = await inspectV2(paths, record.threadId);
          if (inspected) {
            const identityThread = { ...plan.thread, sourceKey: record.identitySeed };
            const normalizedTurns = identityThread.turns.map((turn) => nativeExpectedTurnEvents(
              planV2Thread({ conversation: plan.conversation, resume: record.resumable }, { ...identityThread, turns: [turn] },
                paths, record.projectId, false, String(binding.providerInstanceId), { threadId: record.threadId }), turn, binding.driver).events);
            readback = reconcileNativeHistory(inspected, identityThread, binding, normalizedTurns).target;
          }
        }
        const readbackThread = readback?.records?.thread ?? (readback?.snapshot as V2ThreadReply | undefined)?.records?.thread;
        const expectedHead = plan.events.find((event) => event.type === "provider-thread.updated")?.payload as Record<string, any> | undefined;
        const actualBinding = readback ? providerThreadFor(readback, record.threadId) : undefined;
        const verified = {
          exists: readbackThread?.id === record.threadId,
          project: readbackThread?.projectId === record.projectId,
          activeProvider: readbackThread?.activeProviderThreadId === binding.id,
          providerBinding: Boolean(actualBinding && JSON.stringify(actualBinding.nativeThreadRef ?? null) === JSON.stringify(binding.nativeThreadRef ?? null)),
          conversationHead: Boolean(actualBinding && JSON.stringify(actualBinding.nativeConversationHeadRef ?? null) === JSON.stringify(expectedHead?.nativeConversationHeadRef ?? binding.nativeConversationHeadRef ?? null)),
          history: Boolean(readback && plan.fullPlan && historyMatchesPrefix(readback, plan.fullPlan, plan.thread.turns,
            plan.adopted ? captureNativeProjectionIdentity(plan.target?.records) : record.checkpoint?.version === 2 ? record.checkpoint.nativeProjection : undefined, plan.thread, binding)),
        };
        if (Object.values(verified).some((value) => !value)) {
          throw safetyError(`T3 v2 append could not be verified for ${plan.thread.sourceSessionId} (exists=${verified.exists}, project=${verified.project}, activeProvider=${verified.activeProvider}, providerBinding=${verified.providerBinding}, conversationHead=${verified.conversationHead}, history=${verified.history}); the verified backup is ${backup ?? record.backupPath}.`);
        }
        projectedAfterWrite = readback?.records ?? (readback?.snapshot as V2ThreadReply | undefined)?.records ?? projectedAfterWrite;
        firstSequence = result.storedSequenceRange?.first ?? firstSequence;
        lastSequence = result.storedSequenceRange?.last ?? record.lastSequence;
      }
      const checkpoint = checkpointForThread(plan.thread);
      if (plan.adopted || (record.checkpoint?.version === 2 && record.checkpoint.nativeProjection)) {
        const identity = captureNativeProjectionIdentity(projectedAfterWrite);
        if (!identity) throw safetyError(`T3 did not return projected native history identities for ${plan.thread.sourceSessionId}; the verified backup is ${backup ?? record.backupPath}.`);
        checkpoint.nativeProjection = identity;
      }
      ledger.push({ ...record, targetId: targetId(paths), firstSequence, sourceFingerprint: plan.conversation.fingerprint, currentSourceKey: plan.thread.sourceKey,
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
