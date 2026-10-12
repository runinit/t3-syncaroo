import { describe, expect, it, vi } from "vitest";
import type { CanonicalThread } from "../src/core/types.js";
import { deriveClaudeHistoricalCandidates } from "../src/target/v2/claude-historical-candidates.js";

const uuid = (digit: string) => `00000000-0000-4000-8000-${digit.repeat(12)}`;

function thread(overrides: Partial<CanonicalThread> = {}): CanonicalThread {
  return {
    source: "claude", sourceSessionId: uuid("a"), sourceKey: `claude:${uuid("a")}:${uuid("c")}`,
    leafId: uuid("c"), currentBranch: true, title: "fixture", workspace: "/workspace", model: "claude",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:03.000Z",
    turns: [uuid("1"), uuid("2"), uuid("3")].map((node, index) => ({
      id: uuid(String(index + 4)), startedAt: "2026-01-01T00:00:00.000Z", status: "completed" as const,
      user: { sourceId: uuid(String(index + 4)), role: "user" as const, text: "hi", timestamp: "2026-01-01T00:00:00.000Z", attachments: [] },
      assistant: [{ sourceId: `${node}:text:0`, role: "assistant" as const, text: "done", timestamp: "2026-01-01T00:00:01.000Z", attachments: [] }],
      activities: [], plans: [],
    })),
    warnings: [], ...overrides,
  };
}

const options = (currentThread: CanonicalThread, currentBranchCount = 1) => ({
  currentThread, currentBranchCount,
  sourceKeyForAssistantHead: (head: string) => `claude:${currentThread.sourceSessionId}:${head}`,
  threadIdForSourceKey: (sourceKey: string) => `thread:${sourceKey}`,
});

describe("deriveClaudeHistoricalCandidates", () => {
  it("returns unique trusted terminal heads newest to oldest", () => {
    const current = thread();
    const result = deriveClaudeHistoricalCandidates(options(current));
    expect(result).toEqual([
      { sourceKey: `claude:${current.sourceSessionId}:${uuid("3")}`, threadId: `thread:claude:${current.sourceSessionId}:${uuid("3")}`, leafId: uuid("3") },
      { sourceKey: `claude:${current.sourceSessionId}:${uuid("2")}`, threadId: `thread:claude:${current.sourceSessionId}:${uuid("2")}`, leafId: uuid("2") },
      { sourceKey: `claude:${current.sourceSessionId}:${uuid("1")}`, threadId: `thread:claude:${current.sourceSessionId}:${uuid("1")}`, leafId: uuid("1") },
    ]);
  });

  it("rejects non-Claude, non-current, or ambiguous current branch selection", () => {
    expect(deriveClaudeHistoricalCandidates(options(thread({ source: "codex" })))).toEqual([]);
    expect(deriveClaudeHistoricalCandidates(options(thread({ currentBranch: false })))).toEqual([]);
    expect(deriveClaudeHistoricalCandidates(options(thread(), 2))).toEqual([]);
  });

  it("rejects inconsistent session/source identity and malformed assistant lineage", () => {
    const current = thread();
    expect(deriveClaudeHistoricalCandidates(options(thread({ sourceKey: "claude:other:head" })))).toEqual([]);
    const malformed = thread();
    malformed.turns[1]!.assistant[0]!.sourceId = "not-a-claude-node:text:0";
    expect(deriveClaudeHistoricalCandidates(options(malformed))).toEqual([]);
  });

  it("deduplicates repeated terminal nodes and skips an unsettled turn", () => {
    const current = thread();
    current.turns[1]!.assistant[0]!.sourceId = `${uuid("3")}:text:9`;
    current.turns[2]!.status = "inProgress";
    const result = deriveClaudeHistoricalCandidates(options(current));
    expect(result.map((candidate) => candidate.leafId)).toEqual([uuid("3"), uuid("1")]);
  });

  it("derives identifiers only through the supplied pure callbacks", () => {
    const current = thread();
    const key = vi.fn((head: string) => `key:${head}`);
    const id = vi.fn((sourceKey: string) => `id:${sourceKey}`);
    const result = deriveClaudeHistoricalCandidates({ ...options(current), sourceKeyForAssistantHead: key, threadIdForSourceKey: id });
    expect(result).toHaveLength(3);
    expect(key.mock.calls.map(([head]) => head)).toEqual([uuid("3"), uuid("2"), uuid("1")]);
    expect(id.mock.calls).toHaveLength(3);
  });
});
