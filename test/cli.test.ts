import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createTarget } from "./helpers.js";

const root = process.cwd();

function cli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, ["--import", "tsx", join(root, "src", "cli.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, NO_COLOR: "1" },
  });
}

function writeCodexConversation(path: string, sessionId: string, workspace: string): void {
  writeFileSync(path, [
    { timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: workspace, timestamp: "2026-01-01T00:00:00Z" } },
    { timestamp: "2026-01-01T00:00:00Z", type: "turn_context", payload: { model: "gpt-test", cwd: workspace } },
    { timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    { timestamp: "2026-01-01T00:00:00Z", type: "response_item", payload: { type: "message", role: "user", id: "user-1", content: [{ type: "input_text", text: "Hello" }] } },
    { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "message", role: "assistant", id: "assistant-1", content: [{ type: "output_text", text: "Hi" }] } },
    { timestamp: "2026-01-01T00:00:02Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
}

describe("replace CLI", () => {
  it("exposes only the supported replacement options", () => {
    const result = cli(["replace", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--thread <id>");
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).not.toContain("--all");
    expect(result.stdout).not.toContain("--duplicate");
    expect(result.stdout).not.toContain("--include-incomplete");
  });

  it("rejects the removed duplicate import option", () => {
    const result = cli(["import", "--duplicate"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown option '--duplicate'");
  });

  it("requires explicit confirmation for non-interactive replacement", () => {
    const result = cli(["replace", "--source", "codex", "--workspace", root, "--thread", "fixture", "--non-interactive"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Non-interactive replacement requires --yes");
  });
});

describe("global target options", () => {
  it("describes --db as a T3 state database override", () => {
    const result = cli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/--db <path>\s+T3 state database path/u);
  });

  it("includes unsupported source files and recovery text in JSON discovery", () => {
    const home = mkdtempSync(join(tmpdir(), "t3-import-cli-discovery-"));
    const sessions = join(home, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "ignored.jsonl"), "not a Codex session\n");
    const result = cli(["list", "--source", "codex", "--json"], { ...process.env, CODEX_HOME: home, CODEX_BIN: join(home, "missing-codex") });
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as { conversations: unknown[]; outcomes: Array<{ displayName: string; sourcePath: string; outcome: { kind: string; nextAction: string } }> };
    expect(payload.conversations).toEqual([]);
    expect(payload.outcomes).toEqual([expect.objectContaining({
      displayName: "ignored.jsonl",
      sourcePath: join(sessions, "ignored.jsonl"),
      outcome: expect.objectContaining({ kind: "unsupported", nextAction: expect.stringContaining("rediscover") }),
    })]);
  });

  it("returns a per-session recovery outcome when an explicitly selected session is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "t3-import-cli-missing-session-"));
    const workspace = join(home, "workspace");
    mkdirSync(workspace, { recursive: true });
    const target = createTarget(join(home, "t3"));
    const result = cli(["--json", "--t3-home", target.t3Home, "import", "--source", "codex", "--workspace", workspace, "--thread", "missing-session", "--dry-run"], {
      ...process.env,
      CODEX_HOME: home,
      CODEX_BIN: join(home, "missing-codex"),
    });
    expect(result.status).toBe(6);
    const payload = JSON.parse(result.stdout) as { status: string; results: unknown[]; outcomes: Array<{ sessionId: string; outcome: { kind: string; phase: string; nextAction: string } }> };
    expect(payload).toMatchObject({ status: "no-op", results: [] });
    expect(payload.outcomes).toEqual([expect.objectContaining({
      sessionId: "missing-session",
      outcome: expect.objectContaining({ kind: "failed", phase: "discovery", nextAction: expect.stringContaining("workspace filters") }),
    })]);
  });

  it("validates the target read-only before reporting an empty-install no-op", () => {
    const root = mkdtempSync(join(tmpdir(), "t3-import-cli-empty-install-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const target = createTarget(join(root, "t3"));
    const before = readFileSync(target.dbPath);
    const result = cli(["--json", "--t3-home", target.t3Home, "import", "--source", "codex", "--workspace", workspace, "--all", "--dry-run"], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_BIN: join(root, "missing-codex"),
      T3_IMPORT_DATA_DIR: join(root, "ledger"),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "no-op", outcomes: [], diagnostics: [], counts: { classified: 0, scanDiagnostics: 0 } });
    expect(readFileSync(target.dbPath)).toEqual(before);
    expect(existsSync(target.attachmentsDir)).toBe(false);
    expect(existsSync(join(root, "ledger"))).toBe(false);
  });

  it("keeps all-import session outcomes separate from provider-wide scan diagnostics", () => {
    const root = mkdtempSync(join(tmpdir(), "t3-import-cli-all-diagnostics-"));
    const workspace = join(root, "workspace");
    const sessions = join(root, "sessions");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "unsupported.jsonl"), "not a Codex session\n");
    const target = createTarget(join(root, "t3"));
    const result = cli(["--json", "--t3-home", target.t3Home, "import", "--source", "codex", "--workspace", workspace, "--all", "--dry-run"], {
      ...process.env,
      CODEX_HOME: root,
      CODEX_BIN: join(root, "missing-codex"),
    });
    expect(result.status).toBe(6);
    const payload = JSON.parse(result.stdout) as { outcomes: unknown[]; diagnostics: Array<{ sessionId?: string }>; counts: { classified: number; scanDiagnostics: number } };
    expect(payload.outcomes).toEqual([]);
    expect(payload.diagnostics).toHaveLength(1);
    expect(payload.diagnostics[0]?.sessionId).toBeUndefined();
    expect(payload.counts).toMatchObject({ classified: 0, scanDiagnostics: 1 });
  });

  it("retains the deferred child outcome for an explicit selection without duplicating or including other scan errors", () => {
    const root = mkdtempSync(join(tmpdir(), "t3-import-cli-child-selection-"));
    const workspace = join(root, "workspace");
    const sessions = join(root, "sessions");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    const target = createTarget(join(root, "t3"));
    const sessionId = "77777777-7777-4777-8777-777777777777";
    writeFileSync(join(sessions, "child.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: workspace, timestamp: "2026-01-01T00:00:00Z", thread_source: "agent" } })}\n`);
    writeFileSync(join(sessions, "unrelated.jsonl"), "not a Codex session\n");
    const result = cli(["--json", "--t3-home", target.t3Home, "import", "--source", "codex", "--workspace", workspace, "--thread", sessionId, "--dry-run"], {
      ...process.env,
      CODEX_HOME: root,
      CODEX_BIN: join(root, "missing-codex"),
    });
    expect(result.status).toBe(6);
    const payload = JSON.parse(result.stdout) as { outcomes: Array<{ sessionId: string; outcome: { kind: string; code: string } }>; diagnostics?: unknown[]; counts: { classified: number; deferred: number; failed: number; scanDiagnostics: number } };
    expect(payload.outcomes).toEqual([expect.objectContaining({ sessionId, outcome: expect.objectContaining({ kind: "deferred", code: "child-session-contained-by-parent", message: expect.any(String), nextAction: expect.any(String) }) })]);
    expect(payload.diagnostics).toEqual([]);
    expect(payload.counts).toMatchObject({ classified: 1, deferred: 1, failed: 0, scanDiagnostics: 0 });
  });

  it("continues an import batch when one discovered transcript cannot be loaded", () => {
    const root = mkdtempSync(join(tmpdir(), "t3-import-cli-partial-load-"));
    const workspace = join(root, "workspace");
    const sessions = join(root, "sessions");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    const target = createTarget(join(root, "t3"));
    const validId = "11111111-2222-4333-8444-555555555555";
    const brokenId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    writeCodexConversation(join(sessions, "valid.jsonl"), validId, workspace);
    writeFileSync(join(sessions, "broken.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: brokenId, cwd: workspace, timestamp: "2026-01-01T00:00:00Z" } })}\n{broken JSON\n`);
    const result = cli(["--json", "--t3-home", target.t3Home, "import", "--source", "codex", "--workspace", workspace, "--thread", validId, "--thread", validId, "--thread", brokenId, "--dry-run"], {
      ...process.env,
      CODEX_HOME: root,
      CODEX_BIN: join(root, "missing-codex"),
    });
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      results: Array<{ sourceId: string; status: string }>;
      outcomes: Array<{ sessionId: string; outcome: { kind: string; phase: string; code: string } }>;
      counts: { classified: number; planned: number; failed: number };
    };
    expect(payload.results).toEqual([expect.objectContaining({ sourceId: validId, status: "dry-run" })]);
    expect(payload.outcomes).toEqual([expect.objectContaining({ sessionId: brokenId, outcome: expect.objectContaining({ kind: "failed", phase: "load", code: "source-load-failed" }) })]);
    expect(payload.counts).toMatchObject({ classified: 2, planned: 1, failed: 1 });
  });

  it("reports sync-all sessions without an imported T3 task as deferred", () => {
    const root = mkdtempSync(join(tmpdir(), "t3-import-cli-sync-not-imported-"));
    const workspace = join(root, "workspace");
    const sessions = join(root, "sessions");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    const target = createTarget(join(root, "t3"));
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    writeCodexConversation(join(sessions, "conversation.jsonl"), sessionId, workspace);
    const result = cli(["--json", "--t3-home", target.t3Home, "sync", "--source", "codex", "--workspace", workspace, "--all", "--dry-run", "--yes"], {
      ...process.env,
      CODEX_HOME: root,
      CODEX_BIN: join(root, "missing-codex"),
    });
    expect(result.status).toBe(6);
    const payload = JSON.parse(result.stdout) as { outcomes: Array<{ sessionId: string; outcome: { kind: string; phase: string; nextAction: string } }>; diagnostics: unknown[]; counts: { classified: number; deferred: number; scanDiagnostics: number } };
    expect(payload.outcomes).toEqual([expect.objectContaining({ sessionId, outcome: expect.objectContaining({ kind: "deferred", phase: "preview", nextAction: expect.stringContaining("Import this conversation") }) })]);
    expect(payload.diagnostics).toEqual([]);
    expect(payload.counts).toMatchObject({ classified: 1, deferred: 1, scanDiagnostics: 0 });
  });

  it("keeps incompatible targets as hard failures when source loading yields no sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "t3-import-cli-invalid-empty-target-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const target = createTarget(join(root, "t3"), 54);
    const before = readFileSync(target.dbPath);
    const result = cli(["--json", "--t3-home", target.t3Home, "import", "--source", "codex", "--workspace", workspace, "--all", "--dry-run"], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_BIN: join(root, "missing-codex"),
      T3_IMPORT_DATA_DIR: join(root, "ledger"),
    });
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error" });
    expect(result.stdout).toContain("Unsupported T3 schema migration 54");
    expect(readFileSync(target.dbPath)).toEqual(before);
    expect(existsSync(target.attachmentsDir)).toBe(false);
    expect(existsSync(join(root, "ledger"))).toBe(false);
  });
});
