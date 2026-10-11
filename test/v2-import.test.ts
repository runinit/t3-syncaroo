import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalConversation, canonicalThread, eventCount } from "./helpers.js";
import { resolveTargetPaths } from "../src/target/config.js";
import { importConversations } from "../src/target/importer.js";

const fixture = process.env.T3_V2_FIXTURE_DB;
const helper = fileURLToPath(new URL("../vendor/t3-v2-native-helper.mjs", import.meta.url));
const originalLedgerDir = process.env.T3_IMPORT_DATA_DIR;

afterEach(() => {
  if (originalLedgerDir === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedgerDir;
});

describe.skipIf(!fixture || !existsSync(fixture))("pinned T3 nightly v2 import", () => {
  it("writes, reopens, safely retries, and rejects divergent history through the public importer", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-v2-public-"));
    const workspace = join(root, "workspace");
    const dbPath = join(root, "userdata", "statev2.sqlite");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(root, "userdata"), { recursive: true });
    copyFileSync(fixture!, dbPath);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const paths = resolveTargetPaths({ dbPath });
    const thread = canonicalThread(workspace);
    thread.turns[0]!.activities = [];
    const selection = { conversation: canonicalConversation(workspace, thread), resume: true };

    const first = await importConversations([selection], paths, { dryRun: false, resume: true });
    expect(first.status).toBe("imported");
    expect(first.backup && existsSync(first.backup)).toBe(true);
    const eventTotal = eventCount(dbPath);
    const retry = await importConversations([selection], paths, { dryRun: false, resume: true });
    expect(retry.status).toBe("already-imported");
    expect(eventCount(dbPath)).toBe(eventTotal);

    const inspect = JSON.parse(execFileSync(process.execPath, [helper], {
      input: JSON.stringify({ op: "inspect", dbPath, threadIds: [first.results[0]!.threadId], projectIds: [first.results[0]!.projectId] }),
      encoding: "utf8",
    })) as {
      threads: Array<{ exists: boolean; thread: { projectId: string; historyOrigin: string }; records: { messages: Array<{ role: string; text: string }>; providerThreads: Array<{ appThreadId: string; nativeThreadRef: { nativeId: string; strength: string } }> } }>;
    };
    const imported = inspect.threads[0]!;
    expect(imported.exists).toBe(true);
    expect(imported.thread).toMatchObject({ projectId: first.results[0]!.projectId, historyOrigin: "v1_import" });
    expect(imported.records.messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi" },
    ]);
    expect(imported.records.providerThreads).toContainEqual(expect.objectContaining({
      appThreadId: first.results[0]!.threadId,
      nativeThreadRef: expect.objectContaining({ nativeId: thread.sourceSessionId, strength: "strong" }),
    }));

    const divergent = canonicalThread(workspace);
    divergent.turns[0]!.activities = [];
    divergent.turns[0]!.assistant[0]!.text = "Changed history";
    await expect(importConversations([{ conversation: canonicalConversation(workspace, divergent), resume: true }], paths, { dryRun: false, resume: true }))
      .rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining("different task") });
    expect(eventCount(dbPath)).toBe(eventTotal);
  });
});
