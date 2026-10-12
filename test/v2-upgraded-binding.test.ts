import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkpointForThread } from "../src/core/checkpoint.js";
import { canonicalConversation, canonicalThread } from "./helpers.js";
import { encodeCanonicalHistory } from "../src/target/v2/history.js";
import { verifyUpgradedPrefix } from "../src/target/v2/upgraded-binding.js";
import type { V2Plan, V2ThreadReply } from "../src/target/importer.js";

describe("verifyUpgradedPrefix", () => {
  it("derives and verifies the saved source prefix, then returns the exact native CAS snapshot", () => {
    const root = join(tmpdir(), "t3-upgraded-prefix-workspace");
    const thread = canonicalThread(root);
    thread.turns[0]!.activities = [];
    thread.turns[0]!.plans = [];
    const conversation = canonicalConversation(root, thread);
    const threadId = "converted-thread";
    const projectId = "project-1";
    const history = encodeCanonicalHistory(thread, threadId, join(root, "attachments"));
    const events = history.events;
    const plan = {
      thread, threadId, projectId, identitySeed: thread.sourceKey,
      provider: { instanceId: "codex" }, events,
    } as V2Plan;
    const target = {
      threadId, exists: true,
      thread: { id: threadId, projectId, providerInstanceId: "codex", historyOrigin: "v1_import", activeProviderThreadId: null, latestRunId: null, status: "settled", itemCount: 2 },
      records: {
        thread: { id: threadId, projectId, providerInstanceId: "codex", historyOrigin: "v1_import", activeProviderThreadId: null },
        messages: events.filter((event) => event.type === "message.updated").map((event) => event.payload as Record<string, unknown>),
        turnItems: events.filter((event) => event.type === "turn-item.updated").map((event) => event.payload as Record<string, unknown>),
        plans: [], providerThreads: [], providerTurns: [],
      },
    } as unknown as V2ThreadReply;
    const proof = verifyUpgradedPrefix({
      sourceThread: thread,
      expected: {
        threadId, projectId, providerInstanceId: "codex", sourceSessionId: thread.sourceSessionId,
        nativeThreadId: thread.sourceSessionId, sourceFingerprint: conversation.fingerprint,
        currentFingerprint: conversation.fingerprint, identitySeed: thread.sourceKey,
        checkpoint: checkpointForThread(thread), resumable: true,
      },
      target,
      planPrefix: () => plan,
    });
    expect(proof).toMatchObject({ status: "verified", binding: "absent", prefixThread: { turns: [{ id: thread.turns[0]!.id }] } });
    if (proof.status === "verified") {
      expect(proof.expectedSnapshot).toMatchObject({ thread: target.thread, providerThreads: [], providerTurns: [] });
      expect(proof.expectedSnapshot.thread).not.toEqual(target.records!.thread);
      expect(proof.expectedSnapshot.thread).toHaveProperty("latestRunId", null);
    }

    const missingFullShell = { ...target, thread: null } as V2ThreadReply;
    expect(verifyUpgradedPrefix({
      sourceThread: thread,
      expected: {
        threadId, projectId, providerInstanceId: "codex", sourceSessionId: thread.sourceSessionId,
        nativeThreadId: thread.sourceSessionId, sourceFingerprint: conversation.fingerprint,
        currentFingerprint: conversation.fingerprint, identitySeed: thread.sourceKey,
        checkpoint: checkpointForThread(thread), resumable: true,
      },
      target: missingFullShell,
      planPrefix: () => plan,
    })).toMatchObject({ status: "conflict", reason: expect.stringContaining("complete native thread shell") });

    const divergent = structuredClone(target) as V2ThreadReply;
    divergent.records!.messages![0]!.text = "changed source content";
    expect(verifyUpgradedPrefix({
      sourceThread: thread,
      expected: {
        threadId, projectId, providerInstanceId: "codex", sourceSessionId: thread.sourceSessionId,
        nativeThreadId: thread.sourceSessionId, sourceFingerprint: conversation.fingerprint,
        currentFingerprint: conversation.fingerprint, identitySeed: thread.sourceKey,
        checkpoint: checkpointForThread(thread), resumable: true,
      },
      target: divergent,
      planPrefix: () => plan,
    })).toMatchObject({ status: "conflict" });
  });
});
