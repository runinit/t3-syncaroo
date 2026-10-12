import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sourceAdapter } from "../src/sources/index.js";
import { replayCliPrefixWithNativeSuffix } from "./helpers/v2-cli-native-fixture.js";
import { writeNativeBuiltinFixture } from "./helpers/v2-operational-fixture.js";
import type { SourceName } from "../src/core/types.js";

const fixtureDb = process.env.T3_V2_FIXTURE_DB;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builder = join(repoRoot, "scripts/compatibility/v2-native/gui-fixture.mjs");
const nativeHelper = join(repoRoot, "vendor/t3-v2-native-helper.mjs");
const temporaryHomes: string[] = [];
const environmentKeys = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "T3CODE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "T3_IMPORT_DATA_DIR"];
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const path of temporaryHomes.splice(0)) rmSync(path, { recursive: true, force: true });
  for (const key of environmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function runJson(args: string[], outputDir: string, environment: NodeJS.ProcessEnv, allowNonzero = false): Record<string, any> {
  const cliArgs = args.slice(2);
  for (let index = 0; index < cliArgs.length; index += 1) {
    if (["--t3-home", "--db", "--attachments-dir", "--workspace"].includes(cliArgs[index]!)) {
      cliArgs[index + 1] = resolve(outputDir, cliArgs[index + 1]!);
      index += 1;
    }
  }
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [join(repoRoot, "dist/cli.js"), ...cliArgs], { cwd: repoRoot, env: environment, encoding: "utf8" });
  } catch (error) {
    const detail = error as NodeJS.ErrnoException & { stderr?: Buffer; stdout?: Buffer };
    if (allowNonzero && detail.stdout) return JSON.parse(String(detail.stdout)) as Record<string, any>;
    throw new Error(`${String(error)}\nSTDERR: ${String(detail.stderr ?? "")}\nSTDOUT: ${String(detail.stdout ?? "")}`);
  }
  return JSON.parse(stdout) as Record<string, any>;
}

function inspectThread(dbPath: string, threadId: string): Record<string, any> {
  const reply = JSON.parse(execFileSync(process.execPath, [nativeHelper], {
    cwd: repoRoot, input: JSON.stringify({ op: "inspect", dbPath, threadIds: [threadId] }), encoding: "utf8",
  })) as { threads?: Record<string, any>[] };
  const thread = reply.threads?.[0];
  if (!thread) throw new Error(`Pinned T3 helper did not inspect thread ${threadId}.`);
  return thread;
}

function fingerprintDirectory(path: string): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(path).sort()) {
    hash.update(name);
    hash.update(readFileSync(join(path, name)));
  }
  return hash.digest("hex");
}

function fixtureEnvironment(outputDir: string, manifest: Record<string, any>): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...manifest.providers.codex.environment };
  for (const key of environmentKeys) {
    const value = manifest.providers.codex.environment[key];
    if (typeof value === "string") environment[key] = resolve(outputDir, value);
  }
  return environment;
}

describe.skipIf(!fixtureDb)("pinned CLI native continuation acceptance", () => {
  it.each(["codex", "claude"] as const)("imports, adopts, repeats, and previews an unchanged %s native continuation", async (source) => {
    const outputDir = join(tmpdir(), `t3-native-cli-${source}-${randomUUID()}`);
    temporaryHomes.push(outputDir);
    execFileSync(process.execPath, [builder, "--output-dir", outputDir, "--fixture-db", fixtureDb!, "--import-only"], {
      cwd: repoRoot, env: process.env, encoding: "utf8",
    });
    const manifest = JSON.parse(readFileSync(join(outputDir, "fixture-manifest.json"), "utf8")) as Record<string, any>;
    const provider = manifest.providers[source];
    const environment = fixtureEnvironment(outputDir, manifest);
    for (const key of environmentKeys) process.env[key] = environment[key];
    const dbPath = join(outputDir, "t3-home/userdata/statev2.sqlite");
    const sourceFile = resolve(outputDir, provider.sourceFile);
    const workspace = resolve(outputDir, provider.workspace);
    // Reset only this generated fixture, then import a small synthetic prefix through the real CLI.
    rmSync(dbPath, { force: true });
    rmSync(join(outputDir, "ledger"), { recursive: true, force: true });
    copyFileSync(fixtureDb!, dbPath);
    if (source === "codex") {
      const rows = [
        { timestamp: "2026-10-12T12:20:00.000Z", type: "session_meta", payload: { id: provider.sourceThreadId, cwd: workspace, timestamp: "2026-10-12T12:20:00.000Z" } },
        { timestamp: "2026-10-12T12:20:00.000Z", type: "turn_context", payload: { model: "gpt-test", cwd: workspace } },
        { timestamp: "2026-10-12T12:20:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
        { timestamp: "2026-10-12T12:20:00.000Z", type: "response_item", payload: { type: "message", role: "user", id: "turn-1-user", turn_id: "turn-1", content: [{ type: "input_text", text: "Synthetic imported prefix." }] } },
        { timestamp: "2026-10-12T12:20:03.000Z", type: "response_item", payload: { type: "message", role: "assistant", id: "turn-1-assistant", turn_id: "turn-1", content: [{ type: "output_text", text: "Synthetic prefix accepted." }] } },
        { timestamp: "2026-10-12T12:20:04.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
      ];
      await import("node:fs/promises").then(({ writeFile }) => writeFile(sourceFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n"));
    } else {
      const sessionId = provider.sourceThreadId;
      const rows = [
        { sessionId, cwd: workspace, isSidechain: false, uuid: `${sessionId}-user`, parentUuid: null, type: "user", timestamp: "2026-10-12T12:20:00.000Z", message: { role: "user", content: "Synthetic imported prefix." } },
        { sessionId, cwd: workspace, isSidechain: false, uuid: `${sessionId}-assistant`, parentUuid: `${sessionId}-user`, type: "assistant", timestamp: "2026-10-12T12:20:03.000Z", message: { role: "assistant", model: "claude-test", usage: { input_tokens: 10, output_tokens: 4 }, content: [{ type: "text", text: "Synthetic prefix accepted." }], stop_reason: "end_turn" } },
      ];
      await import("node:fs/promises").then(({ writeFile }) => writeFile(sourceFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n"));
    }
    const imported = runJson(provider.commands.import as string[], outputDir, environment);
    expect(imported.results?.[0]).toMatchObject({ status: "imported" });

    const adapter = sourceAdapter(source as SourceName);
    const initialSummary = (await adapter.discover({ workspace })).find((item) => item.id === provider.sourceThreadId);
    if (!initialSummary) throw new Error(`CLI source adapter did not rediscover ${source} imported prefix.`);
    const initialConversation = await adapter.load(initialSummary, { workspace });
    expect(initialConversation.threads[0]!.turns).toHaveLength(1);

    try {
    if (source === "codex") {
      const rows = [
        { timestamp: "2026-10-12T12:30:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } },
        { timestamp: "2026-10-12T12:30:00.000Z", type: "response_item", payload: { type: "message", role: "user", id: "turn-2-user", turn_id: "turn-2", content: [{ type: "input_text", text: "Continue the imported session." }] } },
        { timestamp: "2026-10-12T12:30:02.500Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 }, total_token_usage: { total_tokens: 25 }, model_context_window: 1000 } } },
        { timestamp: "2026-10-12T12:30:03.000Z", type: "response_item", payload: { type: "message", role: "assistant", id: "turn-2-assistant", turn_id: "turn-2", content: [{ type: "output_text", text: "Native continuation accepted." }] } },
        { timestamp: "2026-10-12T12:30:04.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-2" } },
      ];
      appendFileSync(sourceFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    } else {
      const sessionId = provider.sourceThreadId;
      appendFileSync(sourceFile, [
        { sessionId, cwd: workspace, isSidechain: false, uuid: `${sessionId}-user-2`, parentUuid: `${sessionId}-assistant`, type: "user", timestamp: "2026-10-12T12:30:00.000Z", message: { role: "user", content: "Continue the imported session." } },
        { sessionId, cwd: workspace, isSidechain: false, uuid: `${sessionId}-assistant-2`, parentUuid: `${sessionId}-user-2`, type: "assistant", timestamp: "2026-10-12T12:30:03.000Z", message: { role: "assistant", model: "claude-test", usage: { input_tokens: 20, output_tokens: 5 }, content: [{ type: "text", text: "Native continuation accepted." }], stop_reason: "end_turn" } },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    }

      const summary = (await adapter.discover({ workspace })).find((item) => item.id === provider.sourceThreadId);
      if (!summary) throw new Error(`CLI source adapter did not rediscover ${source} fixture.`);
      const conversation = await adapter.load(summary, { workspace });
      const thread = conversation.threads[0]!;
      thread.turns[0]!.activities = [];
      thread.turns[0]!.plans = [];
      const target = inspectThread(dbPath, provider.threadId);
      const targetProvider = (target.records as Record<string, any>).providerThreads[0];
      const advancedRoot = join(outputDir, "advanced-native");
      mkdirSync(join(advancedRoot, "userdata"), { recursive: true });
      copyFileSync(fixtureDb!, join(advancedRoot, "userdata/statev2.sqlite"));
      const generated = writeNativeBuiltinFixture(advancedRoot, thread, source === "claude" ? "claudeAgent" : "codex", {
        threadId: provider.threadId, projectId: target.thread.projectId,
        providerThreadId: targetProvider.id, runtimeTimestamps: true, operationalCheckpoint: true,
        ...(source === "claude" ? { nativeConversationHeadId: String(thread.resumeCursor?.resumeSessionAt ?? `${provider.sourceThreadId}-assistant-2`) } : {}),
      });
      const replayDbPath = join(outputDir, "replayed-native/statev2.sqlite");
      mkdirSync(join(outputDir, "replayed-native"), { recursive: true });
      copyFileSync(fixtureDb!, replayDbPath);
      const suffixEvents = generated.events.filter((event) => event.type !== "thread.created"
        && (!String(event.id).startsWith("agent-session-import:v2:") || event.type === "provider-thread.updated"))
        .map((event) => event.type === "provider-thread.updated"
          ? { ...event, id: `native-e2e-provider-thread-update:${source}:${provider.sourceThreadId}` }
          : event);
      // Rebuild a pristine fixture via EventSink from the exact CLI import prefix plus native rows.
      // The source ledger remains the one written by public import; prefix event IDs and order stay intact.
      replayCliPrefixWithNativeSuffix({ importedDbPath: dbPath, replayDbPath,
        threadId: provider.threadId, projectId: target.thread.projectId, workspace, suffixEvents });
      const checkpointEvent = suffixEvents.find((event) => event.type === "checkpoint.captured");
      if (!checkpointEvent) throw new Error("Expected persisted operational checkpoint in the native continuation fixture.");
      const tamperedSuffix = structuredClone(suffixEvents);
      const tamperedCheckpoint = tamperedSuffix.find((event) => event.type === "checkpoint.captured");
      if (!tamperedCheckpoint) throw new Error("Could not clone the operational checkpoint fixture.");
      (tamperedCheckpoint.payload as Record<string, unknown>).runId = "foreign-checkpoint-run";
      const tamperedDbPath = join(outputDir, "tampered-native/statev2.sqlite");
      mkdirSync(join(outputDir, "tampered-native"), { recursive: true });
      copyFileSync(fixtureDb!, tamperedDbPath);
      replayCliPrefixWithNativeSuffix({ importedDbPath: dbPath, replayDbPath: tamperedDbPath,
        threadId: provider.threadId, projectId: target.thread.projectId, workspace, suffixEvents: tamperedSuffix });
      copyFileSync(tamperedDbPath, dbPath);
      const beforeTamperedSync = inspectThread(dbPath, provider.threadId).events;
      const ledgerPath = resolve(outputDir, manifest.providers.codex.environment.T3_IMPORT_DATA_DIR);
      const ledgerBeforeRefusal = fingerprintDirectory(ledgerPath);
      const refused = runJson(provider.commands.sync as string[], outputDir, environment, true);
      expect(refused.results?.[0]?.status).toBe("history-diverged");
      expect(inspectThread(dbPath, provider.threadId).events).toEqual(beforeTamperedSync);
      expect(fingerprintDirectory(ledgerPath)).toBe(ledgerBeforeRefusal);
      copyFileSync(replayDbPath, dbPath);

      const first = runJson(provider.commands.sync as string[], outputDir, environment);
      expect(first.results?.[0]).toMatchObject({ status: "synced", turnsAdded: 0, turnsAdopted: 1, events: 1 });
      const second = runJson(provider.commands.sync as string[], outputDir, environment);
      expect(second.results?.[0]).toMatchObject({ status: "up-to-date", turnsAdded: 0, turnsAdopted: 0, events: 0 });
      const beforePreview = inspectThread(dbPath, provider.threadId).events;
      const ledgerBeforePreview = fingerprintDirectory(ledgerPath);
      const replacement = runJson(provider.commands.replacementPreview as string[], outputDir, environment);
      expect(replacement.results?.[0]).toMatchObject({ status: "already-current" });
      expect(inspectThread(dbPath, provider.threadId).events).toEqual(beforePreview);
      expect(fingerprintDirectory(ledgerPath)).toBe(ledgerBeforePreview);
      expect(generated.checkpoint).toMatchObject({ runId: expect.any(String), checkpointId: expect.any(String) });
    } finally {
      await adapter.dispose?.();
    }
  }, 30_000);
});
