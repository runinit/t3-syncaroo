type Row = Record<string, any>;

export interface NativeCheckpointProvenanceInput {
  threadId: string;
  providerThreadId: string;
  providerInstanceId: string;
  driver: "codex" | "claudeAgent";
  sourceNativeTurnId: string;
  /** Provider-turn IDs independently matched to source turns by the caller's native history proof. */
  verifiedSourceProviderTurnIds: string[];
  turnItems: Row[];
  checkpoints: Row[];
  checkpointScopes: Row[];
  runs: Row[];
  runAttempts: Row[];
  nodes: Row[];
  providerTurns: Row[];
}

function exactlyOne<T>(rows: readonly T[], predicate: (row: T) => boolean): T | undefined {
  const matches = rows.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Return checkpoint turn-item IDs whose full native operational provenance is
 * joined to the source provider turn. For weak Claude turn refs, callers must
 * supply IDs already matched by exact assistant-node/item lineage verification;
 * a weak ref alone is never sufficient. This verifies operational artifacts only;
 * source transcript facts (including usage notices) must still be matched separately.
 */
export function deriveVerifiedCheckpointItemIds(input: NativeCheckpointProvenanceInput): string[] {
  if (!input.threadId || !input.providerThreadId || !input.providerInstanceId || !input.sourceNativeTurnId) return [];
  const items = input.turnItems.filter((item) => item.type === "checkpoint");
  const verified: string[] = [];
  for (const item of items) {
    if (item.threadId !== input.threadId || item.status !== "completed" || item.providerThreadId !== input.providerThreadId
      || typeof item.id !== "string" || !item.id || typeof item.runId !== "string" || !item.runId
      || typeof item.nodeId !== "string" || !item.nodeId || typeof item.checkpointId !== "string" || !item.checkpointId
      || typeof item.scopeId !== "string" || !item.scopeId) return [];

    const checkpoint = exactlyOne(input.checkpoints, (row) => row.id === item.checkpointId && row.threadId === input.threadId);
    if (!checkpoint || checkpoint.scopeId !== item.scopeId || checkpoint.runId !== item.runId || checkpoint.nodeId !== item.nodeId
      || (checkpoint.status !== "ready" && checkpoint.status !== "missing") || !Number.isInteger(checkpoint.appRunOrdinal)
      || checkpoint.appRunOrdinal < 1 || !sameJson(checkpoint.files, item.files)) return [];
    const scope = exactlyOne(input.checkpointScopes, (row) => row.id === checkpoint.scopeId && row.threadId === input.threadId);
    if (!scope) return [];

    const run = exactlyOne(input.runs, (row) => row.id === item.runId && row.threadId === input.threadId);
    if (!run || run.status !== "completed" || run.providerInstanceId !== input.providerInstanceId
      || run.providerThreadId !== input.providerThreadId || run.rootNodeId !== item.nodeId
      || run.checkpointId !== checkpoint.id || run.ordinal !== checkpoint.appRunOrdinal
      || typeof run.activeAttemptId !== "string" || !run.activeAttemptId) return [];
    if (scope.runId !== run.id || scope.nodeId !== run.rootNodeId || scope.providerThreadId !== input.providerThreadId
      || scope.kind !== "root_run" || scope.advancesAppRunCount !== true) return [];

    const attempt = exactlyOne(input.runAttempts, (row) => row.id === run.activeAttemptId && row.runId === run.id && row.threadId === input.threadId);
    if (!attempt || attempt.status !== "completed" || attempt.rootNodeId !== run.rootNodeId
      || attempt.providerInstanceId !== input.providerInstanceId || attempt.providerThreadId !== input.providerThreadId) return [];

    const node = exactlyOne(input.nodes, (row) => row.id === run.rootNodeId && row.runId === run.id && row.threadId === input.threadId);
    if (!node || node.kind !== "root_turn" || node.status !== "completed" || node.providerThreadId !== input.providerThreadId
      || node.checkpointScopeId !== checkpoint.scopeId) return [];

    const providerTurn = exactlyOne(input.providerTurns, (row) => row.runAttemptId === attempt.id);
    if (!providerTurn || !input.verifiedSourceProviderTurnIds.includes(providerTurn.id)
      || providerTurn.providerThreadId !== input.providerThreadId || providerTurn.nodeId !== node.id
      || providerTurn.status !== "completed") return [];
    const nativeRef = providerTurn.nativeTurnRef as Row | undefined;
    if (!nativeRef || nativeRef.driver !== input.driver || nativeRef.nativeId !== input.sourceNativeTurnId
      || (input.driver === "codex" && nativeRef.strength !== "strong")
      || (input.driver === "claudeAgent" && nativeRef.strength !== "weak" && nativeRef.strength !== "strong")) return [];

    // Optional provider-turn references may be absent on T3 checkpoint/node/attempt rows.
    // When present, they must all name the same joined provider turn.
    for (const providerTurnId of [item.providerTurnId, attempt.providerTurnId, node.providerTurnId]) {
      if (providerTurnId !== null && providerTurnId !== undefined && providerTurnId !== providerTurn.id) return [];
    }
    verified.push(item.id);
  }
  return verified.length === items.length ? verified : [];
}
