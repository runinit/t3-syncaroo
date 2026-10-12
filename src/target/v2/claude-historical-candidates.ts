import type { CanonicalThread } from "../../core/types.js";

const assistantTextSourceId = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):text:\d+$/iu;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ClaudeHistoricalCandidate {
  sourceKey: string;
  threadId: string;
  leafId: string;
}

export interface ClaudeHistoricalCandidateInput {
  currentThread: CanonicalThread;
  currentBranchCount: number;
  sourceKeyForAssistantHead: (headUuid: string) => string;
  threadIdForSourceKey: (sourceKey: string) => string;
}

/** Derive only deterministic historical Claude identities represented by settled turns in the trusted current lineage. */
export function deriveClaudeHistoricalCandidates(input: ClaudeHistoricalCandidateInput): ClaudeHistoricalCandidate[] {
  const { currentThread } = input;
  if (currentThread.source !== "claude" || currentThread.currentBranch !== true || input.currentBranchCount !== 1
    || !uuid.test(currentThread.sourceSessionId) || !uuid.test(currentThread.leafId ?? "")
    || currentThread.sourceKey !== `claude:${currentThread.sourceSessionId}:${currentThread.leafId}`
    || currentThread.turns.length === 0) return [];

  const candidates: ClaudeHistoricalCandidate[] = [];
  const seenHeads = new Set<string>();
  const seenThreadIds = new Set<string>();
  for (const turn of [...currentThread.turns].reverse()) {
    const assistantHeads: string[] = [];
    for (const message of turn.assistant) {
      const match = assistantTextSourceId.exec(message.sourceId);
      if (!match?.[1]) return [];
      assistantHeads.push(match[1].toLowerCase());
    }
    if (turn.status === "inProgress" || assistantHeads.length === 0) continue;

    const head = assistantHeads.at(-1)!;
    if (seenHeads.has(head)) continue;
    seenHeads.add(head);

    const sourceKey = input.sourceKeyForAssistantHead(head);
    const threadId = input.threadIdForSourceKey(sourceKey);
    if (!sourceKey || !threadId || seenThreadIds.has(threadId)) return [];
    seenThreadIds.add(threadId);
    candidates.push({ sourceKey, threadId, leafId: head });
  }
  return candidates;
}
