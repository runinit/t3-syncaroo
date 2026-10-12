import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function cli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, ["--import", "tsx", join(root, "src", "cli.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, NO_COLOR: "1" },
  });
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
    const result = cli(["--json", "import", "--source", "codex", "--workspace", workspace, "--thread", "missing-session", "--dry-run"], {
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
});
