import type { CanonicalThread } from "../../core/types.js";
import { isTerminalTurn } from "../../core/types.js";
import { legacyTurnSemanticHash, turnSemanticHash, type ImportCheckpoint, type ImportCheckpointV1, type ImportCheckpointV2 } from "../../core/checkpoint.js";
import { projectedHistoryMatches } from "./history.js";
import type { V2Plan, V2ThreadReply } from "../importer.js";

export interface UpgradedBindingExpectation {
  threadId: string;
  projectId: string;
  providerInstanceId: string;
  sourceSessionId: string;
  nativeThreadId: string;
  sourceFingerprint: string;
  currentFingerprint: string;
  identitySeed: string;
  checkpoint?: ImportCheckpoint;
  /** A saved head is required for a bound resumable Claude shell. */
  nativeConversationHeadId?: string;
  /** The caller has independently verified this exact built-in source before attaching its current head. */
  allowNullClaudeHead?: boolean;
  resumable: boolean;
}

export type VerifiedUpgradedPrefix<P extends V2Plan = V2Plan> =
  | { status: "verified"; prefixThread: CanonicalThread; prefixPlan: P; binding: "absent" | "exact" | "needs-head"; expectedSnapshot: Record<string, unknown> }
  | { status: "conflict"; reason: string };

function checkpointPrefix(thread: CanonicalThread, checkpoint: ImportCheckpoint): number | undefined {
  if (thread.turns.length < checkpoint.turns.length) return undefined;
  for (let index = 0; index < checkpoint.turns.length; index++) {
    const saved = checkpoint.turns[index]!;
    const current = thread.turns[index]!;
    if (current.id !== saved.id) return undefined;
    if (checkpoint.version === 1) {
      if (current.status !== "completed" || legacyTurnSemanticHash(current) !== (saved as ImportCheckpointV1["turns"][number]).hash) return undefined;
    } else {
      const expected = saved as ImportCheckpointV2["turns"][number];
      if (!isTerminalTurn(current) || current.status !== expected.status || current.terminalReason !== expected.terminalReason
        || current.terminalError !== expected.terminalError || turnSemanticHash(current) !== expected.hash) return undefined;
    }
  }
  return checkpoint.turns.length;
}

/**
 * Prove that a converted shell contains exactly its saved source prefix and
 * return the native snapshot that must be used as the helper's atomic CAS.
 * Callers remain responsible for asset verification/recovery and for writing
 * an attachment or ledger row only after this proof succeeds.
 */
export function verifyUpgradedPrefix<P extends V2Plan>(input: {
  sourceThread: CanonicalThread;
  expected: UpgradedBindingExpectation;
  target: V2ThreadReply;
  planPrefix: (prefixThread: CanonicalThread) => P;
}): VerifiedUpgradedPrefix<P> {
  const { sourceThread, expected, target } = input;
  const fail = (reason: string): VerifiedUpgradedPrefix<P> => ({ status: "conflict", reason });
  if (!target.exists) return fail("The converted task is missing from the selected native target.");
  if (sourceThread.sourceSessionId !== expected.sourceSessionId) return fail("The source session does not match the saved import mapping.");

  let prefixLength: number;
  if (expected.checkpoint) {
    const savedLength = checkpointPrefix(sourceThread, expected.checkpoint);
    if (savedLength === undefined || savedLength === 0) return fail("The source no longer matches its saved converted-task checkpoint.");
    prefixLength = savedLength;
  } else {
    if (expected.currentFingerprint !== expected.sourceFingerprint) return fail("The converted mapping has no checkpoint and its saved fingerprint no longer matches the full source.");
    prefixLength = sourceThread.turns.length;
  }
  const prefixThread: CanonicalThread = { ...sourceThread, turns: sourceThread.turns.slice(0, prefixLength) };
  const prefixPlan = input.planPrefix(prefixThread);
  if (prefixPlan.threadId !== expected.threadId || prefixPlan.projectId !== expected.projectId
    || prefixPlan.identitySeed !== expected.identitySeed || prefixPlan.provider.instanceId !== expected.providerInstanceId) {
    return fail("The reconstructed source prefix does not preserve the saved task, project, provider, and identity.");
  }

  const records = target.records;
  // The helper's attach operation compares against its complete thread shell.
  // A partial projection is insufficient for this CAS, so fail closed if the
  // inspected reply did not include the shell instead of snapshotting records.thread.
  const nativeThread = target.thread;
  if (!nativeThread) return fail("The converted task is missing its complete native thread shell for binding verification.");
  if (!nativeThread || nativeThread.id !== expected.threadId || nativeThread.projectId !== expected.projectId
    || nativeThread.providerInstanceId !== expected.providerInstanceId || nativeThread.historyOrigin !== "v1_import") {
    return fail("The converted task changed project/provider ownership or import origin.");
  }
  if (!records?.messages || !records.turnItems || !records.plans || !records.providerThreads || !records.providerTurns) {
    return fail("The converted task is missing a required native history projection.");
  }
  const messageCount = prefixPlan.events.filter((event) => event.type === "message.updated").length;
  const itemCount = prefixPlan.events.filter((event) => event.type === "turn-item.updated").length;
  const planCount = prefixPlan.events.filter((event) => event.type === "plan.updated").length;
  if (records.messages.length !== messageCount || records.turnItems.length !== itemCount || records.plans.length !== planCount) {
    return fail("The converted task contains extra, missing, or reordered projected history beyond its saved source prefix.");
  }
  if (!projectedHistoryMatches(records, prefixPlan.events, { identity: "semantic" })) {
    return fail("The converted task's complete projected messages, items, or plans differ from the saved source prefix.");
  }

  const projectedThread = nativeThread as Record<string, any>;
  const activeId = projectedThread.activeProviderThreadId ?? null;
  if (activeId === null && records.providerThreads.length === 0 && records.providerTurns.length === 0) {
    return { status: "verified", prefixThread, prefixPlan, binding: "absent", expectedSnapshot: snapshot(records, nativeThread) };
  }
  if (typeof activeId !== "string" || records.providerThreads.length !== 1 || records.providerTurns.length !== 0) {
    return fail("The converted task has a missing, extra, or ambiguous active provider binding or provider-turn history.");
  }
  const binding = records.providerThreads[0]! as Record<string, any>;
  const driver = sourceThread.source === "codex" ? "codex" : "claudeAgent";
  const nativeRef = binding.nativeThreadRef as Record<string, any> | null;
  if (binding.id !== activeId || binding.appThreadId !== expected.threadId || binding.driver !== driver
    || binding.providerInstanceId !== expected.providerInstanceId
    || (expected.resumable
      ? nativeRef?.driver !== driver || nativeRef.strength !== "strong" || nativeRef.nativeId !== expected.nativeThreadId
      : nativeRef !== null)) {
    return fail("The converted task's active binding does not identify the exact strong source session.");
  }
  const head = binding.nativeConversationHeadRef as Record<string, any> | null;
  if (sourceThread.source === "claude" && expected.resumable
    && !(expected.allowNullClaudeHead && head === null)
    && (!expected.nativeConversationHeadId || head?.driver !== driver || head.strength !== "strong"
      || head.nativeId !== expected.nativeConversationHeadId)) {
    return fail("The converted Claude binding head differs from its saved source head.");
  }
  if ((!expected.resumable || sourceThread.source === "codex") && head !== null) return fail("The converted provider binding has an unexpected conversation head.");
  return { status: "verified", prefixThread, prefixPlan,
    binding: sourceThread.source === "claude" && expected.resumable && expected.allowNullClaudeHead && head === null ? "needs-head" : "exact",
    expectedSnapshot: snapshot(records, nativeThread) };
}

function snapshot(records: NonNullable<V2ThreadReply["records"]>, thread: unknown): Record<string, unknown> {
  return {
    thread,
    messages: records.messages ?? [],
    turnItems: records.turnItems ?? [],
    plans: records.plans ?? [],
    providerThreads: records.providerThreads ?? [],
    providerTurns: records.providerTurns ?? [],
  };
}
