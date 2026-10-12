import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeSource } from "../src/sources/claude.js";
import { CodexSource, inferCurrentWorkspace } from "../src/sources/codex.js";
import { sourceFileErrorCode } from "../src/sources/files.js";

const originalClaudeHome = process.env.CLAUDE_CONFIG_DIR;
const originalCodexHome = process.env.CODEX_HOME;
const originalCodexBin = process.env.CODEX_BIN;
const originalFakeCodexLog = process.env.FAKE_CODEX_LOG;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalCodexBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = originalCodexBin;
  if (originalFakeCodexLog === undefined) delete process.env.FAKE_CODEX_LOG;
  else process.env.FAKE_CODEX_LOG = originalFakeCodexLog;
});

function jsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

describe("source adapters", () => {
  it("classifies a repeatedly changing transcript as retryable", () => {
    expect(sourceFileErrorCode(new Error("SOURCE_CHANGED_DURING_READ"))).toBe("source-changed-during-read");
  });

  it("reports child Codex sessions as deferred under their parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-codex-child-discovery-"));
    const workspace = join(root, "workspace");
    const sessions = join(root, "sessions");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    process.env.CODEX_HOME = root;
    process.env.CODEX_BIN = join(root, "missing-codex-executable");
    const sessionId = "77777777-7777-4777-8777-777777777777";
    const path = join(sessions, "child.jsonl");
    jsonl(path, [{ type: "session_meta", payload: { id: sessionId, cwd: workspace, timestamp: "2026-01-01T00:00:00Z", thread_source: "agent" } }]);

    const adapter = new CodexSource();
    const discovered = await adapter.discoverWithOutcomes({ workspace });
    expect(discovered.summaries).toEqual([]);
    expect(discovered.outcomes).toEqual([expect.objectContaining({
      source: "codex",
      sessionId,
      sourcePath: path,
      outcome: expect.objectContaining({ kind: "deferred", code: "child-session-contained-by-parent", phase: "discovery", nextAction: expect.stringContaining("parent") }),
    })]);
    await adapter.dispose();
  });

  it("reports an unsupported Codex file while retaining valid discovered sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-codex-discovery-outcomes-"));
    const workspace = join(root, "workspace");
    const sessions = join(root, "sessions");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    process.env.CODEX_HOME = root;
    process.env.CODEX_BIN = join(root, "missing-codex-executable");
    const sessionId = "11111111-2222-4333-8444-555555555555";
    jsonl(join(sessions, "valid.jsonl"), [{ type: "session_meta", payload: { id: sessionId, cwd: workspace, timestamp: "2026-01-01T00:00:00Z" } }]);
    writeFileSync(join(sessions, "unrecognized.jsonl"), "not a Codex session\n");

    const adapter = new CodexSource();
    const discovered = await adapter.discoverWithOutcomes({ workspace });
    expect(discovered.summaries.map((summary) => summary.id)).toEqual([sessionId]);
    expect(discovered.outcomes).toEqual([expect.objectContaining({
      source: "codex",
      sourcePath: join(sessions, "unrecognized.jsonl"),
      displayName: "unrecognized.jsonl",
      outcome: expect.objectContaining({ kind: "unsupported", phase: "discovery", code: "unsupported-session-format", nextAction: expect.any(String) }),
    })]);
    await adapter.dispose();
  });

  it("reports an unreadable Claude transcript without dropping valid discovered sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-claude-discovery-outcomes-"));
    const workspace = join(root, "workspace");
    const project = join(root, "projects", "fixture");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(project, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = root;
    const sessionId = "66666666-6666-4666-8666-666666666666";
    jsonl(join(project, `${sessionId}.jsonl`), [
      { sessionId, cwd: workspace, isSidechain: false, uuid: "u1", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00Z", message: { content: "hello" } },
      { sessionId, cwd: workspace, isSidechain: false, uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01Z", message: { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" } },
    ]);
    writeFileSync(join(project, "unreadable.jsonl"), "{broken json\n");

    const discovered = await new ClaudeSource().discoverWithOutcomes({ workspace });
    expect(discovered.summaries.map((summary) => summary.id)).toEqual([sessionId]);
    expect(discovered.outcomes).toEqual([expect.objectContaining({
      source: "claude",
      displayName: "unreadable.jsonl",
      outcome: expect.objectContaining({ kind: "failed", phase: "discovery", code: "source-unreadable", nextAction: expect.any(String) }),
    })]);
  });

  it("reports a provider history folder that cannot be traversed", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-claude-scan-outcome-"));
    process.env.CLAUDE_CONFIG_DIR = root;
    writeFileSync(join(root, "projects"), "not a directory");

    const discovered = await new ClaudeSource().discoverWithOutcomes({});
    expect(discovered.summaries).toEqual([]);
    expect(discovered.outcomes).toEqual([expect.objectContaining({
      source: "claude",
      displayName: "projects",
      outcome: expect.objectContaining({ kind: "failed", phase: "discovery", code: "source-scan-failed", nextAction: expect.stringContaining("readable") }),
    })]);
  });

  it("infers the deepest workspace while canonicalizing each unique path once", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-workspace-inference-"));
    const nested = join(root, "nested");
    const missing = join(root, "historical-missing");
    mkdirSync(nested);
    const summary = (id: string, workspace: string) => ({
      source: "codex" as const,
      id,
      title: id,
      workspace,
      path: `${id}.jsonl`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      status: "complete" as const,
      branches: 1,
    });
    const canonicalize = vi.spyOn(realpathSync, "native");

    const inferred = inferCurrentWorkspace([
      summary("root-1", root),
      summary("root-duplicate", root),
      summary("nested", nested),
      summary("missing", missing),
    ], nested);

    expect(inferred).toBe(nested);
    expect(canonicalize).toHaveBeenCalledTimes(4); // cwd + three unique workspace strings
  });

  it("classifies Codex completed, aborted, failed, non-status error, and active turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-codex-status-"));
    const workspace = join(root, "workspace");
    const sessions = join(root, "sessions", "2026", "01", "01");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    process.env.CODEX_HOME = root;
    process.env.CODEX_BIN = join(root, "missing-codex-executable");
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const rows: unknown[] = [{ timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: workspace } }];
    const start = (id: string, second: number) => rows.push(
      { timestamp: `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`, type: "event_msg", payload: { type: "task_started", turn_id: id } },
      { timestamp: `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`, type: "response_item", payload: { type: "message", role: "user", id: `${id}:user`, content: [{ type: "input_text", text: id }] } },
    );
    start("completed", 1);
    rows.push({ timestamp: "2026-01-01T00:00:02Z", type: "event_msg", payload: { type: "task_complete", turn_id: "completed" } });
    for (const [index, reason] of ["interrupted", "replaced", "review_ended", "budget_limited"].entries()) {
      const id = `abort-${reason}`; start(id, 3 + index * 2);
      rows.push({ timestamp: `2026-01-01T00:00:${String(4 + index * 2).padStart(2, "0")}Z`, type: "event_msg", payload: { type: "turn_aborted", turn_id: id, reason } });
    }
    start("embedded-error", 11);
    rows.push({ timestamp: "2026-01-01T00:00:12Z", type: "event_msg", payload: { type: "task_complete", turn_id: "embedded-error", error: { message: "boom" } } });
    start("non-status-error", 13);
    rows.push(
      { timestamp: "2026-01-01T00:00:14Z", type: "event_msg", payload: { type: "error", turn_id: "non-status-error", message: "rollback warning", codex_error_info: { type: "thread_rollback_failed" } } },
      { timestamp: "2026-01-01T00:00:15Z", type: "event_msg", payload: { type: "task_complete", turn_id: "non-status-error" } },
    );
    start("status-error", 16);
    rows.push(
      { timestamp: "2026-01-01T00:00:17Z", type: "event_msg", payload: { type: "error", turn_id: "status-error", message: "provider failed", codex_error_info: { type: "response_failed" } } },
      { timestamp: "2026-01-01T00:00:18Z", type: "event_msg", payload: { type: "task_complete", turn_id: "status-error" } },
    );
    start("active", 19);
    jsonl(join(sessions, `rollout-${sessionId}.jsonl`), rows);

    const adapter = new CodexSource();
    const summary = (await adapter.discover({ workspace }))[0]!;
    const conversation = await adapter.load(summary, {});
    const thread = conversation.threads[0]!;
    expect(thread.turns.map((turn) => turn.status)).toEqual(["completed", "interrupted", "interrupted", "interrupted", "interrupted", "failed", "completed", "failed"]);
    expect(thread.turns.slice(1, 5).map((turn) => turn.terminalReason)).toEqual(["interrupted", "replaced", "review_ended", "budget_limited"]);
    expect(thread.turns[5]).toMatchObject({ terminalError: "boom" });
    expect(thread.turns[6]!.activities).toContainEqual(expect.objectContaining({ kind: "provider.error" }));
    expect(thread.ignoredInProgressTurns).toBe(1);
    const withActive = await adapter.load(summary, { includeIncomplete: true });
    expect(withActive.threads[0]!.turns.at(-1)).toMatchObject({ id: "active", status: "inProgress" });
    await adapter.dispose();
  });

  it("ignores the pre-task manual context handoff without losing the resumed or active source turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-codex-manual-context-"));
    const workspace = join(root, "workspace");
    const sessions = join(root, "sessions", "2026", "10", "11");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    process.env.CODEX_HOME = root;
    process.env.CODEX_BIN = join(root, "missing-codex-executable");
    const sessionId = "55555555-6666-4777-8888-999999999999";
    const row = (second: number, type: string, payload: Record<string, unknown>) => ({
      timestamp: `2026-10-11T20:59:${String(second).padStart(2, "0")}Z`, type, payload,
    });
    jsonl(join(sessions, `rollout-${sessionId}.jsonl`), [
      row(0, "session_meta", { id: sessionId, cwd: workspace }),
      row(1, "event_msg", { type: "task_started", turn_id: "prior" }),
      row(1, "response_item", { type: "message", role: "user", id: "prior-user", content: [{ type: "input_text", text: "Ordinary prior prompt" }] }),
      row(2, "response_item", { type: "message", role: "assistant", id: "prior-assistant", content: [{ type: "output_text", text: "Prior answer" }] }),
      row(3, "event_msg", { type: "task_complete", turn_id: "prior" }),
      row(4, "response_item", { type: "message", role: "user", id: "generated-handoff", content: [{ type: "input_text", text: "Context handoff (manual_context):\nProvider context handoff. Thread: task-123.\nRecover omitted history using t3_thread_read(...)." }] }),
      row(5, "response_item", { type: "message", role: "user", id: "compacted-history-user", content: [{ type: "input_text", text: "Compacted historical user message" }] }),
      row(6, "response_item", { type: "message", role: "assistant", id: "compacted-history-assistant", content: [{ type: "output_text", text: "Compacted historical assistant message" }] }),
      row(7, "event_msg", { type: "task_started", turn_id: "resumed" }),
      row(8, "response_item", { type: "message", role: "user", id: "resumed-user", content: [{ type: "input_text", text: "Reply exactly CONTINUED_CODEX_OK." }] }),
      row(9, "response_item", { type: "message", role: "assistant", id: "resumed-assistant", content: [{ type: "output_text", text: "CONTINUED_CODEX_OK" }] }),
      row(10, "event_msg", { type: "task_complete", turn_id: "resumed" }),
      row(11, "event_msg", { type: "task_started", turn_id: "still-active" }),
      row(11, "response_item", { type: "message", role: "user", id: "active-user", content: [{ type: "input_text", text: "Leave this genuinely unfinished" }] }),
    ]);

    const adapter = new CodexSource();
    const summary = (await adapter.discover({ workspace }))[0]!;
    const conversation = await adapter.load(summary, {});
    const thread = conversation.threads[0]!;
    expect(thread.turns.map((turn) => [turn.id, turn.status, turn.user.text])).toEqual([
      ["prior", "completed", "Ordinary prior prompt"],
      ["resumed", "completed", "Reply exactly CONTINUED_CODEX_OK."],
    ]);
    expect(thread.ignoredInProgressTurns).toBe(1);
    const withActive = await adapter.load(summary, { includeIncomplete: true });
    expect(withActive.threads[0]!.turns.at(-1)).toMatchObject({ id: "still-active", status: "inProgress", user: { text: "Leave this genuinely unfinished" } });
    await adapter.dispose();
  });

  it("classifies Claude truncation, refusal, context failure, API retry, and active continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-claude-status-"));
    const workspace = join(root, "workspace");
    const project = join(root, "projects", "fixture");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(project, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = root;
    const sessionId = "66666666-6666-4666-8666-666666666666";
    const base = { sessionId, cwd: workspace, isSidechain: false };
    jsonl(join(project, `${sessionId}.jsonl`), [
      { ...base, uuid: "u1", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00Z", message: { content: "truncate" } },
      { ...base, uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01Z", message: { content: [{ type: "text", text: "partial" }], stop_reason: "max_tokens" } },
      { ...base, uuid: "u2", parentUuid: "a1", type: "user", timestamp: "2026-01-01T00:00:02Z", message: { content: "refuse" } },
      { ...base, uuid: "a2", parentUuid: "u2", type: "assistant", timestamp: "2026-01-01T00:00:03Z", message: { content: [{ type: "text", text: "cannot" }], stop_reason: "refusal" } },
      { ...base, uuid: "u3", parentUuid: "a2", type: "user", timestamp: "2026-01-01T00:00:04Z", message: { content: "overflow" } },
      { ...base, uuid: "retry", parentUuid: "u3", type: "system", subtype: "api_error", timestamp: "2026-01-01T00:00:05Z", message: "retrying", retryAttempt: 1, maxRetries: 3 },
      { ...base, uuid: "a3", parentUuid: "retry", type: "assistant", timestamp: "2026-01-01T00:00:06Z", message: { content: [{ type: "text", text: "too large" }], stop_reason: "model_context_window_exceeded" } },
      { ...base, uuid: "u4", parentUuid: "a3", type: "user", timestamp: "2026-01-01T00:00:07Z", message: { content: "still running" } },
      { ...base, uuid: "a4", parentUuid: "u4", type: "assistant", timestamp: "2026-01-01T00:00:08Z", message: { content: [{ type: "text", text: "working" }], stop_reason: "tool_use" } },
      { ...base, uuid: "result4", parentUuid: "a4", type: "result", subtype: "error_during_execution", is_error: true, result: "execution broke", timestamp: "2026-01-01T00:00:09Z" },
      { ...base, uuid: "u5", parentUuid: "result4", type: "user", timestamp: "2026-01-01T00:00:10Z", message: { content: "active" } },
      { ...base, uuid: "a5", parentUuid: "u5", type: "assistant", timestamp: "2026-01-01T00:00:11Z", message: { content: [{ type: "text", text: "working again" }], stop_reason: "pause_turn" } },
    ]);

    const adapter = new ClaudeSource();
    const summary = (await adapter.discover({ workspace }))[0]!;
    const conversation = await adapter.load(summary, {});
    const thread = conversation.threads[0]!;
    expect(thread.turns.map((turn) => turn.status)).toEqual(["interrupted", "completed", "failed", "failed"]);
    expect(thread.turns[0]).toMatchObject({ terminalReason: "max_tokens" });
    expect(thread.turns[1]!.activities).toContainEqual(expect.objectContaining({ kind: "provider.refusal" }));
    expect(thread.turns[2]!.activities).toContainEqual(expect.objectContaining({ kind: "provider.error" }));
    expect(thread.turns[3]).toMatchObject({ terminalReason: "error_during_execution", terminalError: "execution broke" });
    expect(thread.ignoredInProgressTurns).toBe(1);
  });

  it("settles historical Claude turns without terminal markers when a later user turn exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-claude-historical-interruption-"));
    const workspace = join(root, "workspace");
    const project = join(root, "projects", "fixture");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(project, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = root;
    const sessionId = "99999999-9999-4999-8999-999999999999";
    const base = { sessionId, cwd: workspace, isSidechain: false };
    jsonl(join(project, `${sessionId}.jsonl`), [
      { ...base, uuid: "u1", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00Z", message: { content: "Start" } },
      { ...base, uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01Z", message: { content: [{ type: "text", text: "Still working" }], stop_reason: "tool_use" } },
      { ...base, uuid: "u2", parentUuid: "a1", type: "user", timestamp: "2026-01-01T00:00:02Z", message: { content: "Continue" } },
      { ...base, uuid: "a2", parentUuid: "u2", type: "assistant", timestamp: "2026-01-01T00:00:03Z", message: { content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" } },
      { ...base, uuid: "u3", parentUuid: "a2", type: "user", timestamp: "2026-01-01T00:00:04Z", message: { content: "Trailing" } },
      { ...base, uuid: "a3", parentUuid: "u3", type: "assistant", timestamp: "2026-01-01T00:00:05Z", message: { content: [{ type: "text", text: "Active" }], stop_reason: "tool_use" } },
      { ...base, type: "last-prompt", leafUuid: "u3", lastPrompt: "Trailing" },
    ]);

    const adapter = new ClaudeSource();
    const summary = (await adapter.discover({ workspace }))[0]!;
    const conversation = await adapter.load(summary, {});
    expect(conversation.threads[0]!.turns.map((turn) => turn.status)).toEqual(["interrupted", "completed"]);
    expect(conversation.threads[0]!.turns[0]).toMatchObject({ terminalReason: "next_user_message", completedAt: "2026-01-01T00:00:02.000Z" });
    expect(conversation.threads[0]!.turns[0]!.activities).toContainEqual(expect.objectContaining({ kind: "turn.interrupted" }));
    expect(conversation.threads[0]!.ignoredInProgressTurns).toBe(1);
    const withActive = await adapter.load(summary, { includeIncomplete: true });
    expect(withActive.threads[0]!.turns.map((turn) => turn.status)).toEqual(["interrupted", "completed", "inProgress"]);
  });

  it("keeps Claude's originating workspace, separates real branches, and ignores parallel tool-result leaves", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-claude-"));
    const workspace = join(root, "workspace");
    const project = join(root, "projects", "fixture");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(workspace, "nested"), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = root;
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const base = { sessionId, version: "test" };
    jsonl(join(project, `${sessionId}.jsonl`), [
      { ...base, uuid: "u", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00Z", cwd: workspace, isSidechain: false, message: { role: "user", content: "Build it" } },
      { ...base, uuid: "metadata", parentUuid: "u", type: "attachment", timestamp: "2026-01-01T00:00:00.100Z", cwd: workspace, attachment: { type: "metadata" } },
      { ...base, uuid: "a1", parentUuid: "metadata", type: "assistant", timestamp: "2026-01-01T00:00:01Z", cwd: join(workspace, "nested"), isSidechain: false, message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "Working" }], stop_reason: "tool_use" } },
      { ...base, uuid: "t1", parentUuid: "a1", type: "assistant", timestamp: "2026-01-01T00:00:02Z", cwd: join(workspace, "nested"), isSidechain: false, message: { role: "assistant", model: "claude-test", content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "one" } }], stop_reason: "tool_use" } },
      { ...base, uuid: "t2", parentUuid: "t1", type: "assistant", timestamp: "2026-01-01T00:00:03Z", cwd: join(workspace, "nested"), isSidechain: false, message: { role: "assistant", model: "claude-test", content: [{ type: "tool_use", id: "call-2", name: "Bash", input: { command: "two" } }], stop_reason: "tool_use" } },
      { ...base, uuid: "r1", parentUuid: "t1", type: "user", timestamp: "2026-01-01T00:00:04Z", cwd: workspace, isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "one-result" }] } },
      { ...base, uuid: "r2", parentUuid: "t2", type: "user", timestamp: "2026-01-01T00:00:05Z", cwd: workspace, isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-2", content: "two-result" }] } },
      { ...base, uuid: "alternate", parentUuid: "metadata", type: "assistant", timestamp: "2026-01-01T00:00:05.500Z", cwd: workspace, isSidechain: false, message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "Historical answer" }], stop_reason: "end_turn" } },
      { ...base, uuid: "alternate-next", parentUuid: "alternate", type: "user", timestamp: "2026-01-01T00:00:05.750Z", cwd: workspace, isSidechain: false, message: { role: "user", content: "An unanswered prompt on the alternate branch" } },
      { ...base, type: "last-prompt", leafUuid: "r2", lastPrompt: "Build it" },
      { ...base, uuid: "done", parentUuid: "r2", type: "assistant", timestamp: "2026-01-01T00:00:06Z", cwd: workspace, isSidechain: false, message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" } },
    ]);

    const adapter = new ClaudeSource();
    const summaries = await adapter.discover({ workspace });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ workspace, branches: 2 });
    const conversation = await adapter.load(summaries[0]!, {});
    expect(conversation.threads).toHaveLength(2);
    const current = conversation.threads.find((thread) => thread.currentBranch)!;
    const historical = conversation.threads.find((thread) => !thread.currentBranch)!;
    expect(current.turns[0]!.activities.map((item) => item.sourceId)).toEqual(expect.arrayContaining(["call-1", "call-2"]));
    expect(current.resumeCursor).toMatchObject({ resume: sessionId, resumeSessionAt: "done", turnCount: 1 });
    expect(historical.resumeCursor).toMatchObject({ resume: sessionId, resumeSessionAt: "alternate", turnCount: 2 });
    expect(historical.leafId).toBe("alternate-next");
    expect(historical.title).toContain("historical");
    expect(historical.warnings[0]).toContain("Alternate Claude branch");
  });

  it("does not guess Claude's active branch when last-prompt is missing or stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-claude-ambiguous-"));
    const workspace = join(root, "workspace");
    const project = join(root, "projects", "fixture");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(project, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = root;
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const base = { sessionId, cwd: workspace, isSidechain: false };
    jsonl(join(project, `${sessionId}.jsonl`), [
      { ...base, uuid: "u", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00Z", message: { content: "Build it" } },
      { ...base, uuid: "a", parentUuid: "u", type: "assistant", timestamp: "2026-01-01T00:00:01Z", message: { content: [{ type: "text", text: "First answer" }], stop_reason: "end_turn" } },
      { ...base, uuid: "b", parentUuid: "u", type: "assistant", timestamp: "2026-01-01T00:00:02Z", message: { content: [{ type: "text", text: "Other answer" }], stop_reason: "end_turn" } },
      { ...base, type: "last-prompt", leafUuid: "missing-leaf", lastPrompt: "Build it" },
    ]);

    const adapter = new ClaudeSource();
    const summary = (await adapter.discover({ workspace }))[0]!;
    const conversation = await adapter.load(summary, {});
    expect(conversation.threads).toHaveLength(2);
    expect(conversation.threads.every((thread) => !thread.currentBranch)).toBe(true);
    expect(conversation.threads.every((thread) => thread.warnings[0]?.includes("active branch is ambiguous"))).toBe(true);
    expect(conversation.threads.map((thread) => thread.resumeCursor?.resumeSessionAt).sort()).toEqual(["a", "b"]);
  });

  it("relinks a successful API retry and an automatic compaction into one Claude thread", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-claude-relinked-"));
    const workspace = join(root, "workspace");
    const project = join(root, "projects", "fixture");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(project, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = root;
    const sessionId = "77777777-7777-4777-8777-777777777777";
    const base = { sessionId, cwd: workspace, isSidechain: false };
    jsonl(join(project, `${sessionId}.jsonl`), [
      { ...base, uuid: "u1", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00Z", message: { content: "Build it" } },
      { ...base, uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01Z", message: { content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "test" } }], stop_reason: "tool_use" } },
      { ...base, uuid: "r1", parentUuid: "a1", type: "user", timestamp: "2026-01-01T00:00:02Z", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] } },
      { ...base, uuid: "retry", parentUuid: "r1", type: "system", subtype: "api_error", timestamp: "2026-01-01T00:00:03Z", retryAttempt: 1, maxRetries: 10, error: "connection reset" },
      { ...base, uuid: "recovered", parentUuid: "r1", type: "assistant", timestamp: "2026-01-01T00:00:04Z", message: { content: [{ type: "text", text: "Recovered" }], stop_reason: "end_turn" } },
      { ...base, uuid: "hook", parentUuid: "retry", type: "system", subtype: "stop_hook_summary", timestamp: "2026-01-01T00:00:05Z" },
      { ...base, uuid: "u2", parentUuid: "hook", type: "user", timestamp: "2026-01-01T00:00:06Z", message: { content: "Continue" } },
      { ...base, uuid: "a2", parentUuid: "u2", type: "assistant", timestamp: "2026-01-01T00:00:07Z", message: { content: [{ type: "text", text: "Before compaction" }], stop_reason: "tool_use" } },
      { ...base, uuid: "compact", parentUuid: null, logicalParentUuid: "a2", type: "system", subtype: "compact_boundary", timestamp: "2026-01-01T00:00:08Z", compactMetadata: { trigger: "auto" } },
      { ...base, uuid: "summary", parentUuid: "compact", type: "user", timestamp: "2026-01-01T00:00:08.100Z", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: "This session is being continued from a previous conversation" } },
      { ...base, uuid: "a3", parentUuid: "summary", type: "assistant", timestamp: "2026-01-01T00:00:09Z", message: { content: [{ type: "text", text: "Finished continuation" }], stop_reason: "end_turn" } },
      { ...base, uuid: "u3", parentUuid: "a3", type: "user", timestamp: "2026-01-01T00:00:10Z", message: { content: "Next" } },
      { ...base, uuid: "a4", parentUuid: "u3", type: "assistant", timestamp: "2026-01-01T00:00:11Z", message: { content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" } },
      { ...base, type: "last-prompt", leafUuid: "u3", lastPrompt: "Next" },
    ]);

    const adapter = new ClaudeSource();
    const summary = (await adapter.discover({ workspace }))[0]!;
    expect(summary.branches).toBe(1);
    const conversation = await adapter.load(summary, {});
    expect(conversation.threads).toHaveLength(1);
    const thread = conversation.threads[0]!;
    expect(thread.turns.map((turn) => turn.user.text)).toEqual(["Build it", "Continue", "Next"]);
    expect(thread.turns[0]!.assistant.map((message) => message.text)).toContain("Recovered");
    expect(thread.turns[0]!.activities).toContainEqual(expect.objectContaining({ kind: "provider.error" }));
    expect(thread.turns[1]!.assistant.map((message) => message.text)).toEqual(["Before compaction", "Finished continuation"]);
    expect(thread.turns[1]!.activities).toContainEqual(expect.objectContaining({ kind: "context-compaction" }));
    expect(thread.resumeCursor).toMatchObject({ resume: sessionId, resumeSessionAt: "a4", turnCount: 3 });
  });

  it("parses a Codex rollout without app-server data", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-codex-"));
    const workspace = join(root, "workspace");
    const sessions = join(root, "sessions", "2026", "01", "01");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    process.env.CODEX_HOME = root;
    process.env.CODEX_BIN = join(root, "missing-codex-executable");
    const sessionId = "33333333-3333-4333-8333-333333333333";
    jsonl(join(root, "session_index.jsonl"), [
      { id: sessionId, thread_name: "Saved Codex conversation name", updated_at: "2026-01-01T00:00:04Z" },
    ]);
    jsonl(join(sessions, `rollout-${sessionId}.jsonl`), [
      { timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: workspace, timestamp: "2026-01-01T00:00:00Z" } },
      { timestamp: "2026-01-01T00:00:00Z", type: "turn_context", payload: { model: "gpt-test", effort: "high", cwd: workspace } },
      { timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      { timestamp: "2026-01-01T00:00:00Z", type: "response_item", payload: { type: "message", role: "user", id: "user-1", content: [{ type: "input_text", text: "Hello" }] } },
      { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "shell_command", arguments: "{\"command\":\"pwd\"}" } },
      { timestamp: "2026-01-01T00:00:02Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "ok" } },
      { timestamp: "2026-01-01T00:00:02.500Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13 }, total_token_usage: { total_tokens: 20 }, model_context_window: 1000 } } },
      { timestamp: "2026-01-01T00:00:03Z", type: "response_item", payload: { type: "message", role: "assistant", id: "assistant-1", content: [{ type: "output_text", text: "Hi" }] } },
      { timestamp: "2026-01-01T00:00:04Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ]);

    const adapter = new CodexSource();
    const summaries = await adapter.discover({ workspace });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.title).toBe("Saved Codex conversation name");
    const conversation = await adapter.load(summaries[0]!, {});
    expect(conversation.threads[0]!.title).toBe("Saved Codex conversation name");
    expect(conversation.threads[0]).toMatchObject({ sourceSessionId: sessionId, workspace, model: "gpt-test" });
    expect(conversation.threads[0]!.turns[0]!.activities[0]).toMatchObject({ sourceId: "call-1", kind: "tool.completed" });
    expect(conversation.threads[0]!.turns[0]!.activities).toContainEqual(expect.objectContaining({ kind: "context-window.updated", payload: expect.objectContaining({ usedTokens: 13, maxTokens: 1000 }) }));
    await adapter.dispose();
  });

  it("discovers Codex workspaces from rollout headers without parsing the transcript body", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-codex-fast-"));
    const workspace = join(root, "workspace");
    const sessions = join(root, "sessions", "2026", "01", "01");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    process.env.CODEX_HOME = root;
    process.env.CODEX_BIN = join(root, "missing-codex-executable");
    const sessionId = "44444444-4444-4444-8444-444444444444";
    writeFileSync(join(sessions, `rollout-${sessionId}.jsonl`), [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: workspace } }),
      "this deliberately malformed transcript body is not workspace metadata",
    ].join("\n"));

    const adapter = new CodexSource();
    const summaries = await adapter.discover({});
    expect(summaries).toEqual([expect.objectContaining({ id: sessionId, workspace, path: expect.stringContaining(sessionId) })]);
    await expect(adapter.load(summaries[0]!, {})).rejects.toMatchObject({ exitCode: 5 });
    await adapter.dispose();
  });

  it("reuses one Codex app-server for listing and multiple thread reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-codex-server-"));
    const workspace = join(root, "workspace");
    const sessions = join(root, "sessions", "2026", "01", "01");
    const log = join(root, "app-server.log");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    process.env.CODEX_HOME = root;
    process.env.FAKE_CODEX_LOG = log;
    const serverPath = join(root, "fake-codex.mjs");
    writeFileSync(serverPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(process.env.FAKE_CODEX_LOG, "spawn\\n");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  appendFileSync(process.env.FAKE_CODEX_LOG, request.method + "\\n");
  const result = request.method === "thread/list" ? { data: [], nextCursor: null }
    : request.method === "thread/read" ? { thread: { id: request.params.threadId, name: "App title", turns: [{ id: request.params.threadId + ":turn", status: "interrupted" }] } } : {};
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
}
`);
    if (process.platform === "win32") {
      const command = join(root, "fake-codex.cmd");
      writeFileSync(command, `@echo off\r\nnode "%~dp0fake-codex.mjs" %*\r\n`);
      process.env.CODEX_BIN = command;
    } else {
      chmodSync(serverPath, 0o755);
      process.env.CODEX_BIN = serverPath;
    }
    const ids = ["55555555-5555-4555-8555-555555555551", "55555555-5555-4555-8555-555555555552"];
    for (const id of ids) jsonl(join(sessions, `rollout-${id}.jsonl`), [
      { timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id, cwd: workspace } },
      { timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: `${id}:turn` } },
      { timestamp: "2026-01-01T00:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] } },
      { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi" }] } },
      { timestamp: "2026-01-01T00:00:02Z", type: "event_msg", payload: { type: "task_complete", turn_id: `${id}:turn` } },
    ]);

    const adapter = new CodexSource();
    const summaries = await adapter.discover({ workspace });
    const loaded = await Promise.all(summaries.map((summary) => adapter.load(summary, { workspace })));
    expect(loaded.map((conversation) => conversation.threads[0]!.turns[0]!.status)).toEqual(["interrupted", "interrupted"]);
    await adapter.dispose();
    const calls = readFileSync(log, "utf8").trim().split(/\r?\n/u);
    expect(calls.filter((call) => call === "spawn")).toHaveLength(1);
    expect(calls.filter((call) => call === "thread/list")).toHaveLength(1);
    expect(calls.filter((call) => call === "thread/read")).toHaveLength(2);
  });
});
