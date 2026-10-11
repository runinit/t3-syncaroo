import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { eventCount } from "./helpers.js";
import { canonicalPath, sha256 } from "../src/core/util.js";
import { listImports } from "../src/target/ledger.js";
import { ClaudeSource } from "../src/sources/claude.js";
import { resolveTargetPaths } from "../src/target/config.js";
import { importConversations } from "../src/target/importer.js";

const fixture = process.env.T3_V2_FIXTURE_DB;
const helper = fileURLToPath(new URL("../vendor/t3-v2-native-helper.mjs", import.meta.url));
const originalLedgerDir = process.env.T3_IMPORT_DATA_DIR;
const originalClaudeHome = process.env.CLAUDE_CONFIG_DIR;

afterEach(() => {
  if (originalLedgerDir === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedgerDir;
  if (originalClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeHome;
});

describe.skipIf(!fixture || !existsSync(fixture))("pinned T3 nightly v2 Claude import", () => {
  it("imports Claude branch history, plans, activity, and image bytes with the exact branch head", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-v2-claude-"));
    const workspace = join(root, "workspace");
    const claudeHome = join(root, "claude");
    const projectDir = join(claudeHome, "projects", "fixture");
    const dbPath = join(root, "userdata", "statev2.sqlite");
    const attachmentsDir = join(root, "userdata", "attachments");
    const sessionId = "22222222-2222-4222-8222-222222222222";
    mkdirSync(workspace, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(root, "userdata"), { recursive: true });
    copyFileSync(fixture!, dbPath);
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const base = { sessionId, cwd: workspace, isSidechain: false };
    const imageBytes = Buffer.from("synthetic-claude-image");
    const markdown = "1. Inspect the branch\n2. Preserve its state";
    const transcript = [
      { ...base, uuid: "user-root", parentUuid: null, type: "user", timestamp: "2026-10-01T10:00:00Z", message: { role: "user", content: [
        { type: "text", text: "Implement this carefully" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: imageBytes.toString("base64") } },
      ] } },
      { ...base, uuid: "assistant-tool", parentUuid: "user-root", type: "assistant", timestamp: "2026-10-01T10:00:01Z", message: {
        model: "claude-test", stop_reason: "tool_use", usage: { input_tokens: 40, output_tokens: 12 },
        content: [
          { type: "thinking", thinking: "I should inspect the current state." },
          { type: "tool_use", id: "todo-call", name: "TodoWrite", input: { todos: [{ content: "Inspect the branch", status: "completed" }, { content: "Preserve its state", status: "in_progress" }] } },
          { type: "tool_use", id: "plan-call", name: "ExitPlanMode", input: { plan: markdown } },
          { type: "tool_use", id: "shell-call", name: "Bash", input: { command: "pwd" } },
        ],
      } },
      { ...base, uuid: "tool-results", parentUuid: "assistant-tool", type: "user", timestamp: "2026-10-01T10:00:02Z", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "todo-call", content: "Updated tasks" },
        { type: "tool_result", tool_use_id: "plan-call", content: "Plan accepted" },
        { type: "tool_result", tool_use_id: "shell-call", content: "/workspace" },
      ] } },
      { ...base, uuid: "assistant-current", parentUuid: "tool-results", type: "assistant", timestamp: "2026-10-01T10:00:03Z", message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "Current branch answer" }], stop_reason: "end_turn" } },
      { ...base, uuid: "assistant-alternate", parentUuid: "assistant-tool", type: "assistant", timestamp: "2026-10-01T10:00:04Z", message: { role: "assistant", model: "claude-test", usage: { input_tokens: 80, output_tokens: 20 }, content: [{ type: "text", text: "First alternate response" }], stop_reason: "max_tokens" } },
      { ...base, uuid: "alternate-user-2", parentUuid: "assistant-alternate", type: "user", timestamp: "2026-10-01T10:00:05Z", message: { role: "user", content: "Try a smaller step" } },
      { ...base, uuid: "assistant-failed", parentUuid: "alternate-user-2", type: "assistant", timestamp: "2026-10-01T10:00:06Z", message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "This turn exceeds the context window" }], stop_reason: "model_context_window_exceeded" } },
      { ...base, uuid: "alternate-user-3", parentUuid: "assistant-failed", type: "user", timestamp: "2026-10-01T10:00:07Z", message: { role: "user", content: "Continue with a fresh turn" } },
      { ...base, uuid: "assistant-alternate-completed", parentUuid: "alternate-user-3", type: "assistant", timestamp: "2026-10-01T10:00:08Z", message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "Alternate branch answer" }], stop_reason: "end_turn" } },
      { ...base, uuid: "alternate-user-endpoint", parentUuid: "assistant-alternate-completed", type: "user", timestamp: "2026-10-01T10:00:09Z", message: { role: "user", content: "Continue from this saved branch" } },
      { ...base, type: "last-prompt", leafUuid: "assistant-current", lastPrompt: "Implement this carefully" },
    ];
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), transcript.map((row) => JSON.stringify(row)).join("\n") + "\n");

    const source = new ClaudeSource();
    const summary = (await source.discover({ workspace }))[0]!;
    const discovered = await source.load(summary, {});
    const conversation = { ...discovered, threads: discovered.threads.filter((thread) => thread.leafId === "alternate-user-endpoint") };
    expect(conversation.threads).toHaveLength(1);
    const branch = conversation.threads[0]!;
    expect(branch).toMatchObject({ currentBranch: false, leafId: "alternate-user-endpoint" });
    expect(branch.resumeCursor).toMatchObject({ resume: sessionId, resumeSessionAt: "assistant-alternate-completed" });
    expect(branch.turns.map((turn) => turn.status)).toEqual(["interrupted", "failed", "completed"]);
    expect(branch.turns[0]!.plans.map((plan) => plan.markdown)).toContain(markdown);
    expect(branch.turns[0]!.activities.map((activity) => activity.kind)).toEqual(expect.arrayContaining([
      "reasoning.summary", "turn.plan.updated", "tool.completed", "context-window.updated",
    ]));

    const paths = resolveTargetPaths({ dbPath });
    const result = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
    expect(result.status).toBe("imported");
    expect(result.results[0]).toMatchObject({ source: "claude", resumable: true, attachments: 1 });

    const inspected = JSON.parse(execFileSync(process.execPath, [helper], {
      input: JSON.stringify({ op: "inspect", dbPath, threadIds: [result.results[0]!.threadId] }),
      encoding: "utf8",
    })) as {
      threads: Array<{
        records: {
          messages: Array<{ role: string; text: string; attachments: Array<{ id: string }> }>;
          turnItems: Array<{ type: string; status: string; text?: string; input?: string; output?: string; steps?: Array<{ text: string }> }>;
          plans: Array<{ markdown?: string }>;
          providerThreads: Array<{
            driver: string;
            providerInstanceId: string;
            nativeThreadRef: { driver: string; nativeId: string; strength: string };
            nativeConversationHeadRef: { driver: string; nativeId: string; strength: string } | null;
          }>;
        };
      }>;
    };
    const records = inspected.threads[0]!.records;
    expect(records.messages[0]!.role).toBe("user");
    expect(records.messages[0]!.attachments).toHaveLength(1);
    expect(readFileSync(join(attachmentsDir, `${records.messages[0]!.attachments[0]!.id}.png`))).toEqual(imageBytes);
    expect(records.turnItems.map((item) => item.type)).toEqual(expect.arrayContaining([
      "reasoning", "todo_list", "proposed_plan", "dynamic_tool", "system_notice",
    ]));
    expect(records.turnItems.find((item) => item.type === "todo_list")?.steps?.map((step) => step.text)).toEqual([
      "Inspect the branch", "Preserve its state",
    ]);
    expect(records.turnItems.map((item) => item.status)).toEqual(expect.arrayContaining(["completed", "interrupted", "failed"]));
    expect(records.turnItems.some((item) => item.type === "error" && item.status === "failed")).toBe(true);
    expect(records.plans.map((plan) => plan.markdown)).toContain(markdown);
    expect(records.providerThreads).toContainEqual(expect.objectContaining({
      driver: "claudeAgent",
      providerInstanceId: "claudeAgent",
      nativeThreadRef: { driver: "claudeAgent", nativeId: sessionId, strength: "strong" },
      nativeConversationHeadRef: { driver: "claudeAgent", nativeId: "assistant-alternate-completed", strength: "strong" },
    }));

    const targetId = sha256(canonicalPath(dbPath));
    expect(listImports(targetId, "claude")).toContainEqual(expect.objectContaining({
      source: "claude",
      sourceSessionId: sessionId,
      sourceKey: branch.sourceKey,
      sourceLeafId: "alternate-user-endpoint",
      threadId: result.results[0]!.threadId,
      resumable: true,
    }));
    const eventTotal = eventCount(dbPath);
    const retry = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
    expect(retry.status).toBe("already-imported");
    expect(eventCount(dbPath)).toBe(eventTotal);

    await expect(importConversations([{ conversation, resume: true }], paths, {
      dryRun: false,
      resume: true,
      providerInstance: "claudeAgent-alt",
    })).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining("different task") });
    expect(eventCount(dbPath)).toBe(eventTotal);
  });
});
