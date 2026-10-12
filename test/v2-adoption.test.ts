import { describe, expect, it } from "vitest";
import { canonicalThread } from "./helpers.js";
import { matchBuiltinImport, type BuiltinImportProjection } from "../src/target/v2/adoption.js";
import { encodeCanonicalHistory } from "../src/target/v2/history.js";
import type { CanonicalThread } from "../src/core/types.js";

const providerInstanceId = "codex";
const project = { id: "project-1", workspaceRoot: "/tmp/adoption-workspace" };
const attachmentsDir = "/tmp/adoption-attachments";

function textThread(): CanonicalThread {
  const thread = canonicalThread(project.workspaceRoot);
  thread.turns[0]!.activities = [];
  return thread;
}

function builtInTarget(thread: CanonicalThread, provider = "codex", instance = providerInstanceId): BuiltinImportProjection {
  const threadId = `import:${instance}:${thread.sourceSessionId}`;
  const history = encodeCanonicalHistory(thread, threadId, attachmentsDir);
  const expectedItems = history.events.filter((event) => event.type === "turn-item.updated").map((event) => event.payload as Record<string, unknown>);
  const messages = history.events.filter((event) => event.type === "message.updated").map((event, index) => ({
    ...(event.payload as Record<string, unknown>), id: `message-${index}`, threadId,
  })) as NonNullable<NonNullable<BuiltinImportProjection["records"]>["messages"]>;
  return {
    exists: true,
    thread: { id: threadId, projectId: project.id, historyOrigin: "v1_import", providerInstanceId: instance, activeProviderThreadId: "provider-row" },
    records: {
      thread: { id: threadId, projectId: project.id, historyOrigin: "v1_import", providerInstanceId: instance, activeProviderThreadId: "provider-row" },
      messages,
      turnItems: expectedItems.map((item, index) => ({ ...item, id: `built-in-item-${index}`, threadId, messageId: `message-${index}`, ordinal: index + 1 })),
      plans: [],
      providerTurns: [],
      providerThreads: [{
        id: "provider-row", appThreadId: threadId, driver: provider, providerInstanceId: instance,
        nativeThreadRef: { driver: provider, nativeId: thread.sourceSessionId, strength: "strong" },
        nativeConversationHeadRef: null,
      }],
    },
  };
}

function input(thread: CanonicalThread, target = builtInTarget(thread)) {
  return { thread, sourceCandidates: [thread], providerInstanceId, project, target, attachmentsDir };
}

describe("built-in import adoption matcher", () => {
  it("accepts a complete Codex text history with the exact provider and project binding", () => {
    const thread = textThread();
    const result = matchBuiltinImport(input(thread));

    expect(result).toMatchObject({ status: "match", threadId: `import:${providerInstanceId}:${thread.sourceSessionId}`, providerThreadId: "provider-row" });
    if (result.status === "match") expect(result.providerConversationHeadEvent).toBeUndefined();
  });

  it("rejects a shared title or message prefix when any identity or full-history check differs", () => {
    const thread = textThread();
    const altered = builtInTarget(thread);
    altered.records!.thread!.projectId = "other-project";
    altered.thread!.projectId = "other-project";
    expect(matchBuiltinImport(input(thread, altered))).toMatchObject({ status: "conflict" });

    const divergent = builtInTarget(thread);
    divergent.records!.messages![0]!.text = "Hello, changed";
    expect(matchBuiltinImport(input(thread, divergent))).toMatchObject({ status: "conflict" });

    const wrongProvider = builtInTarget(thread);
    wrongProvider.records!.providerThreads![0]!.nativeThreadRef = { driver: "codex", nativeId: "different-session", strength: "strong" };
    expect(matchBuiltinImport(input(thread, wrongProvider))).toMatchObject({ status: "conflict" });
  });

  it("rejects incomplete built-in projections and rich source history", () => {
    const thread = textThread();
    const missing = builtInTarget(thread);
    missing.records!.turnItems!.pop();
    expect(matchBuiltinImport(input(thread, missing))).toMatchObject({ status: "conflict" });

    const rich = textThread();
    rich.turns[0]!.activities = [{ sourceId: "activity-1", tone: "tool", kind: "tool.completed", summary: "Ran a command", timestamp: rich.updatedAt, payload: {} }];
    expect(matchBuiltinImport(input(rich, builtInTarget(rich)))).toMatchObject({ status: "conflict" });

    const missingProviderTurns = builtInTarget(thread);
    delete missingProviderTurns.records!.providerTurns;
    expect(matchBuiltinImport(input(thread, missingProviderTurns))).toMatchObject({ status: "conflict" });

    const image = textThread();
    image.turns[0]!.user.attachments = [{ sourceId: "image-1", name: "diagram.png", mimeType: "image/png", sizeBytes: 3, data: Buffer.from("png") }];
    expect(matchBuiltinImport(input(image, builtInTarget(image)))).toMatchObject({ status: "conflict" });
  });

  it("attaches only the exact unique Claude branch head after a full text match", () => {
    const thread = textThread();
    thread.source = "claude";
    thread.sourceSessionId = "claude-session";
    thread.sourceKey = "claude:claude-session:branch-leaf";
    thread.leafId = "branch-leaf";
    thread.resumeCursor = { resume: "claude-session", resumeSessionAt: "assistant-node-uuid", turnCount: 1 };
    thread.turns[0]!.assistant[0]!.sourceId = "assistant-node-uuid:text:0";
    const target = builtInTarget(thread, "claudeAgent", "claudeAgent");
    const result = matchBuiltinImport({ ...input(thread, target), providerInstanceId: "claudeAgent" });

    expect(result).toMatchObject({ status: "match", providerConversationHeadEvent: {
      type: "provider-thread.updated", threadId: `import:claudeAgent:${thread.sourceSessionId}`,
      payload: { nativeConversationHeadRef: { driver: "claudeAgent", nativeId: "assistant-node-uuid", strength: "strong" } },
    } });
  });

  it("recovers an already committed exact Claude head attach only with its deterministic event ownership", () => {
    const thread = textThread();
    thread.source = "claude";
    thread.sourceSessionId = "claude-session";
    thread.sourceKey = "claude:claude-session:branch-leaf";
    thread.leafId = "branch-leaf";
    thread.resumeCursor = { resume: "claude-session", resumeSessionAt: "assistant-node-uuid", turnCount: 1 };
    thread.turns[0]!.assistant[0]!.sourceId = "assistant-node-uuid:text:0";
    const target = builtInTarget(thread, "claudeAgent", "claudeAgent");
    const first = matchBuiltinImport({ ...input(thread, target), providerInstanceId: "claudeAgent" });
    expect(first.status).toBe("match");
    if (first.status !== "match" || !first.providerConversationHeadEvent) throw new Error("Expected a Claude head attach proposal");
    target.records!.providerThreads![0]!.nativeConversationHeadRef = {
      driver: "claudeAgent", nativeId: "assistant-node-uuid", strength: "strong",
    };
    target.events = [{ ...first.providerConversationHeadEvent, sequence: 100 } as NonNullable<BuiltinImportProjection["events"]>[number]];
    expect(matchBuiltinImport({ ...input(thread, target), providerInstanceId: "claudeAgent" })).toMatchObject({
      status: "match", providerThreadId: "provider-row",
    });
    target.events = [{ ...first.providerConversationHeadEvent, sequence: 100, payload: { ...(first.providerConversationHeadEvent.payload as Record<string, unknown>), driver: "codex" } } as unknown as NonNullable<BuiltinImportProjection["events"]>[number]];
    expect(matchBuiltinImport({ ...input(thread, target), providerInstanceId: "claudeAgent" })).toMatchObject({ status: "conflict" });
    target.events = [];
    expect(matchBuiltinImport({ ...input(thread, target), providerInstanceId: "claudeAgent" })).toMatchObject({ status: "conflict" });
  });

  it("rejects Claude branch ambiguity and never fabricates a head from message text", () => {
    const thread = textThread();
    thread.source = "claude";
    thread.sourceSessionId = "claude-session";
    thread.sourceKey = "claude:claude-session:branch-leaf";
    thread.leafId = "branch-leaf";
    thread.resumeCursor = { resume: "claude-session", resumeSessionAt: "assistant-node-uuid", turnCount: 1 };
    const duplicate = { ...thread, sourceKey: "claude:claude-session:other-leaf", leafId: "other-leaf" };
    const result = matchBuiltinImport({ ...input(thread, builtInTarget(thread, "claudeAgent", "claudeAgent")), providerInstanceId: "claudeAgent", sourceCandidates: [thread, duplicate] });
    expect(result).toMatchObject({ status: "conflict" });

    thread.resumeCursor = { resume: "claude-session" };
    expect(matchBuiltinImport({ ...input(thread, builtInTarget(thread, "claudeAgent", "claudeAgent")), providerInstanceId: "claudeAgent" })).toMatchObject({ status: "conflict" });
  });
});
