import { describe, expect, it } from "vitest";
import { deriveVerifiedCheckpointItemIds, type NativeCheckpointProvenanceInput } from "../src/target/v2/native-checkpoint-provenance.js";

// The positive record chain is copied from the documented synthetic Codex QA DB
// inspect response (T3 0.0.46-nightly.20261011.2994).
const threadId = "01a12d9f-0d98-74f2-9b12-b4226632c3f3";
const providerThreadId = "38f05315-5f7d-5cb5-9689-1a6b326f671f";
const runId = `run:thread:${threadId}:ordinal:1`;
const nodeId = `node:run:run%3Athread%3A${threadId}%3Aordinal%3A1:root`;
const attemptId = `run-attempt:run:run%3Athread%3A${threadId}%3Aordinal%3A1:attempt:1`;
const scopeId = `checkpoint-scope:thread:${threadId}:name:root`;
const checkpointId = `checkpoint:scope:checkpoint-scope%3Athread%3A${threadId}%3Aname%3Aroot:name:1`;
const sourceNativeTurnId = "01a12da4-ef39-7ce1-835e-a8a8b0d319a1";
const input = (): NativeCheckpointProvenanceInput => ({
  threadId,
  providerThreadId,
  providerInstanceId: "codex",
  driver: "codex" as const,
  sourceNativeTurnId,
  verifiedSourceProviderTurnIds: [`provider-turn:provider:codex:native-turn:${sourceNativeTurnId}`],
  turnItems: [{ id: `turn-item:provider:codex:native-item:checkpoint%3A${encodeURIComponent(checkpointId)}`, threadId, type: "checkpoint", status: "completed", runId, nodeId, providerThreadId, providerTurnId: null, checkpointId, scopeId, files: [] }],
  checkpoints: [{ id: checkpointId, threadId, scopeId, runId, nodeId, parentCheckpointId: `checkpoint:scope:checkpoint-scope%3Athread%3A${threadId}%3Aname%3Aroot:name:0`, appRunOrdinal: 1, status: "missing", capturedAt: "2026-10-12T01:05:49.473Z", files: [] }],
  checkpointScopes: [{ id: scopeId, threadId, runId, nodeId, providerThreadId, kind: "root_run", advancesAppRunCount: true, name: "root" }],
  runs: [{ id: runId, threadId, ordinal: 1, providerInstanceId: "codex", providerThreadId, rootNodeId: nodeId, activeAttemptId: attemptId, status: "completed", checkpointId }],
  runAttempts: [{ id: attemptId, threadId, runId, attemptOrdinal: 1, rootNodeId: nodeId, providerInstanceId: "codex", providerThreadId, providerTurnId: null, status: "completed" }],
  nodes: [{ id: nodeId, threadId, runId, kind: "root_turn", status: "completed", providerThreadId, providerTurnId: null, checkpointScopeId: scopeId }],
  providerTurns: [{ id: `provider-turn:provider:codex:native-turn:${sourceNativeTurnId}`, threadId, providerThreadId, nodeId, runAttemptId: attemptId, nativeTurnRef: { driver: "codex", nativeId: sourceNativeTurnId, strength: "strong" }, ordinal: 1, status: "completed" }],
});

describe("native operational checkpoint provenance", () => {
  it("accepts a checkpoint only through a completed run, attempt, node, and source-native provider turn", () => {
    expect(deriveVerifiedCheckpointItemIds(input())).toEqual([input().turnItems[0]!.id]);
  });

  it("accepts the native ready checkpoint status as well as missing", () => {
    const value = input();
    value.checkpoints[0]!.status = "ready";
    expect(deriveVerifiedCheckpointItemIds(value)).toEqual([value.turnItems[0]!.id]);
  });

  it("accepts a weak Claude turn reference only when the caller proved its source lineage", () => {
    const value = input();
    value.driver = "claudeAgent";
    value.providerInstanceId = "claudeAgent";
    value.runs[0]!.providerInstanceId = "claudeAgent";
    value.runAttempts[0]!.providerInstanceId = "claudeAgent";
    value.providerTurns[0]!.nativeTurnRef.driver = "claudeAgent";
    value.providerTurns[0]!.nativeTurnRef.strength = "weak";
    expect(deriveVerifiedCheckpointItemIds(value)).toEqual([value.turnItems[0]!.id]);
    value.verifiedSourceProviderTurnIds = [];
    expect(deriveVerifiedCheckpointItemIds(value)).toEqual([]);
  });

  it.each([
    ["failed run", (value: ReturnType<typeof input>) => { value.runs[0]!.status = "failed"; }],
    ["failed attempt", (value: ReturnType<typeof input>) => { value.runAttempts[0]!.status = "failed"; }],
    ["error checkpoint", (value: ReturnType<typeof input>) => { value.checkpoints[0]!.status = "error"; }],
    ["stale checkpoint", (value: ReturnType<typeof input>) => { value.checkpoints[0]!.status = "stale"; }],
    ["foreign source turn", (value: ReturnType<typeof input>) => { value.providerTurns[0]!.nativeTurnRef.nativeId = "foreign-turn"; }],
    ["weak source reference", (value: ReturnType<typeof input>) => { value.providerTurns[0]!.nativeTurnRef.strength = "weak"; }],
    ["foreign node", (value: ReturnType<typeof input>) => { value.providerTurns[0]!.nodeId = "other-node"; }],
    ["foreign provider-turn thread", (value: ReturnType<typeof input>) => { value.providerTurns[0]!.threadId = "foreign-thread"; }],
    ["ambiguous provider turns", (value: ReturnType<typeof input>) => { value.providerTurns.push({ ...value.providerTurns[0]!, id: "provider-turn-2" }); }],
    ["foreign extra provider turn on same attempt", (value: ReturnType<typeof input>) => { value.providerTurns.push({ ...value.providerTurns[0]!, id: "provider-turn-2", nodeId: "foreign-node" }); }],
    ["unlinked extra checkpoint item", (value: ReturnType<typeof input>) => { value.turnItems.push({ ...value.turnItems[0]!, id: "item-2", checkpointId: "foreign-checkpoint" }); }],
  ])("rejects %s", (_name, mutate) => {
    const value = input();
    mutate(value);
    expect(deriveVerifiedCheckpointItemIds(value)).toEqual([]);
  });

  it("retains older checkpoint proof after the shared root scope advances to a later completed run", () => {
    const value = input();
    const laterRun: Record<string, any> = { ...value.runs[0]!, id: "later-run", rootNodeId: "later-root", ordinal: 2 };
    value.runs.push(laterRun);
    value.nodes.push({ ...value.nodes[0]!, id: "later-root", runId: "later-run" });
    value.checkpointScopes[0]!.runId = "later-run";
    value.checkpointScopes[0]!.nodeId = "later-root";
    expect(deriveVerifiedCheckpointItemIds(value)).toEqual([value.turnItems[0]!.id]);
    laterRun.providerThreadId = "foreign-provider-thread";
    expect(deriveVerifiedCheckpointItemIds(value)).toEqual([]);
  });

  it("returns only checkpoint IDs and leaves source usage notices as separate history", () => {
    const value = input();
    value.turnItems.push({ id: "usage-item", threadId, type: "system_notice", status: "completed", text: "Context window updated" });
    expect(deriveVerifiedCheckpointItemIds(value)).toEqual([input().turnItems[0]!.id]);
  });
});
