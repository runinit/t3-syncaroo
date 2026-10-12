import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkpointForThread } from "../src/core/checkpoint.js";
import { canonicalPath, sha256 } from "../src/core/util.js";
import { resolveTargetPaths } from "../src/target/config.js";
import { listImports, recordImports, type LedgerRecord } from "../src/target/ledger.js";
import { importConversations } from "../src/target/importer.js";
import { replaceConversations } from "../src/target/replace.js";
import { syncConversations } from "../src/target/sync.js";
import { canonicalConversation, canonicalThread, eventCount } from "./helpers.js";

const t3SourceDir = process.env.T3_V2_T3_SOURCE_DIR;
const t3DependencyRoot = process.env.T3_V2_T3_DEPENDENCY_ROOT;
const fixtureRunner = fileURLToPath(new URL("../scripts/compatibility/v2-native/legacy-upgrade-fixture.mjs", import.meta.url));
const originalLedgerDir = process.env.T3_IMPORT_DATA_DIR;

afterEach(() => {
  if (originalLedgerDir === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedgerDir;
});

async function upgradedCodexFixture(prefix: string) {
  const tempRoot = join(process.cwd(), "node_modules/.cache");
  mkdirSync(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, prefix));
  const workspace = join(root, "source-workspace");
  mkdirSync(workspace, { recursive: true });
  const fixtureOut = execFileSync(process.execPath, [fixtureRunner, root], {
    env: { ...process.env, T3_V2_T3_SOURCE_DIR: t3SourceDir!,
      ...(t3DependencyRoot ? { T3_V2_T3_DEPENDENCY_ROOT: t3DependencyRoot } : {}),
      T3_V2_UPGRADE_WORKSPACE: workspace }, encoding: "utf8",
  }).trim().split("\n").at(-1)!;
  const fixture = JSON.parse(fixtureOut) as { dbPath: string; threadId: string };
  const ledgerDir = join(root, "ledger");
  process.env.T3_IMPORT_DATA_DIR = ledgerDir;
  const paths = resolveTargetPaths({ dbPath: fixture.dbPath });
  const thread = canonicalThread(workspace);
  thread.sourceSessionId = fixture.threadId;
  thread.sourceKey = `codex:${fixture.threadId}`;
  thread.model = "gpt-5.4";
  thread.createdAt = "2026-01-01T00:00:00.000Z";
  thread.updatedAt = "2026-01-01T00:00:02.000Z";
  thread.resumeCursor = { threadId: fixture.threadId };
  thread.turns[0]!.completedAt = thread.updatedAt;
  thread.turns[0]!.user.sourceId = "legacy-message-06-user";
  thread.turns[0]!.user.text = "Question";
  thread.turns[0]!.user.timestamp = "2026-01-01T00:00:00.000Z";
  thread.turns[0]!.assistant = [{ sourceId: "legacy-message-06-assistant", role: "assistant", text: "Answer", timestamp: "2026-01-01T00:00:01.000Z", attachments: [] }];
  thread.turns[0]!.activities = [];
  const importedConversation = canonicalConversation(workspace, thread);
  const importedCheckpoint = checkpointForThread(thread);
  const oldTargetId = sha256(canonicalPath(join(paths.stateDir, "state.sqlite")));
  const oldRecord: LedgerRecord = {
    targetId: oldTargetId, source: "codex", sourceSessionId: thread.sourceSessionId,
    sourceKey: thread.sourceKey, sourceFingerprint: importedConversation.fingerprint,
    projectId: "project-06", threadId: fixture.threadId, importedAt: "2026-02-01T00:00:00.000Z",
    importerVersion: "0.3.0", migration: 52, firstSequence: 901, lastSequence: 907,
    resumable: true, backupPath: join(root, "legacy-backup.sqlite"), warnings: [],
    identitySeed: thread.sourceKey, currentSourceKey: thread.sourceKey,
    sourceTitle: thread.title, checkpoint: importedCheckpoint, isCanonical: true,
  };
  recordImports([oldRecord]);
  return { root, workspace, fixture, paths, thread, oldRecord, importedConversation };
}

function appendFollowup(thread: ReturnType<typeof canonicalThread>) {
  const first = thread.turns[0]!;
  thread.turns.push({
    ...first,
    id: "codex-turn-07",
    startedAt: "2026-01-01T00:00:03.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    user: { ...first.user, sourceId: "codex-user-07", text: "Follow-up", timestamp: "2026-01-01T00:00:03.000Z" },
    assistant: [{ sourceId: "codex-assistant-07", role: "assistant", text: "Follow-up answer", timestamp: "2026-01-01T00:00:04.000Z", attachments: [] }],
  });
  thread.updatedAt = "2026-01-01T00:00:05.000Z";
  return thread;
}

describe.skipIf(!t3SourceDir || !existsSync(t3SourceDir))("public sync and replace of converted imports", () => {
  it("does not duplicate a converted Claude import when its source key advanced and its ledger is missing", async () => {
    const tempRoot = join(process.cwd(), "node_modules/.cache");
    mkdirSync(tempRoot, { recursive: true });
    const root = await mkdtemp(join(tempRoot, "t3-v2-upgrade-claude-missing-ledger-"));
    const workspace = join(root, "source-workspace");
    mkdirSync(workspace, { recursive: true });
    const fixtureOut = execFileSync(process.execPath, [fixtureRunner, root], {
      env: { ...process.env, T3_V2_T3_SOURCE_DIR: t3SourceDir!,
        ...(t3DependencyRoot ? { T3_V2_T3_DEPENDENCY_ROOT: t3DependencyRoot } : {}),
        T3_V2_UPGRADE_WORKSPACE: workspace, T3_V2_UPGRADE_PROVIDER_INSTANCE: "claudeAgent" }, encoding: "utf8",
    }).trim().split("\n").at(-1)!;
    const fixture = JSON.parse(fixtureOut) as { dbPath: string; threadId: string };
    const ledgerDir = join(root, "ledger");
    process.env.T3_IMPORT_DATA_DIR = ledgerDir;
    const paths = resolveTargetPaths({ dbPath: fixture.dbPath });
    const sourceSessionId = "claude-session-06";
    const sourceThread = canonicalThread(workspace);
    sourceThread.source = "claude";
    sourceThread.sourceSessionId = sourceSessionId;
    sourceThread.sourceKey = `claude:${sourceSessionId}:assistant-head-07`;
    sourceThread.leafId = "assistant-head-07";
    sourceThread.model = "claude-test";
    sourceThread.createdAt = "2026-01-01T00:00:00.000Z";
    sourceThread.updatedAt = "2026-01-01T00:00:02.000Z";
    sourceThread.resumeCursor = { resume: sourceSessionId, resumeSessionAt: "assistant-head-07" };
    sourceThread.turns[0]!.completedAt = sourceThread.updatedAt;
    sourceThread.turns[0]!.user.sourceId = "legacy-message-06-user";
    sourceThread.turns[0]!.user.text = "Question";
    sourceThread.turns[0]!.user.timestamp = "2026-01-01T00:00:00.000Z";
    sourceThread.turns[0]!.assistant = [{ sourceId: "legacy-message-06-assistant", role: "assistant", text: "Answer", timestamp: "2026-01-01T00:00:01.000Z", attachments: [] }];
    sourceThread.turns[0]!.activities = [];
    const conversation = canonicalConversation(workspace, sourceThread);
    const before = eventCount(fixture.dbPath);

    const result = await importConversations([{ conversation, resume: true }], paths,
      { dryRun: false, resume: true, providerInstance: "claudeAgent" });

    expect(result.results[0]).toMatchObject({ status: "already-imported", threadId: fixture.threadId });
    expect(eventCount(fixture.dbPath)).toBeLessThanOrEqual(before + 1);
    const db = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) count FROM orchestration_v2_projection_threads WHERE project_id = 'project-06'").get())
        .toMatchObject({ count: 1 });
    } finally { db.close(); }
  });

  it("syncs from an old-target-only ledger into its converted task without reimporting the prefix", async () => {
    const { fixture, paths, thread, oldRecord } = await upgradedCodexFixture("t3-v2-upgrade-sync-");
    appendFollowup(thread);
    const conversation = canonicalConversation(thread.workspace, thread);
    const before = eventCount(fixture.dbPath);

    const result = await syncConversations([{ conversation }], paths, { dryRun: false });

    expect(result.results[0]).toMatchObject({ status: "synced", threadId: fixture.threadId, turnsAdded: 1 });
    expect(eventCount(fixture.dbPath)).toBeGreaterThan(before);
    const db = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) count FROM projection_thread_messages WHERE thread_id = ?").get(fixture.threadId))
        .toMatchObject({ count: 4 });
    } finally { db.close(); }
    const currentRecord = listImports(sha256(canonicalPath(fixture.dbPath)), "codex").find((record) => record.threadId === fixture.threadId);
    expect(currentRecord).toBeDefined();
    expect(currentRecord!.firstSequence).not.toBe(oldRecord.firstSequence);
    expect(currentRecord!.lastSequence).not.toBe(oldRecord.lastSequence);
  });

  it("replaces a converted task addressed only by its old-target ledger row", async () => {
    const { root, fixture, paths, thread, oldRecord } = await upgradedCodexFixture("t3-v2-upgrade-replace-");
    appendFollowup(thread);
    const conversation = canonicalConversation(thread.workspace, thread);
    const ledgerPath = join(root, "ledger", "ledger.sqlite");
    const ledger = new Database(ledgerPath);
    ledger.exec("CREATE TRIGGER reject_upgrade_replacement_ledger BEFORE INSERT ON imports BEGIN SELECT RAISE(ABORT, 'injected replacement ledger interruption'); END;");
    ledger.close();
    const before = eventCount(fixture.dbPath);

    const result = await replaceConversations([{ conversation }], paths, { dryRun: false });

    expect(result.results[0]).toMatchObject({ status: "replaced", oldThreadId: fixture.threadId });
    expect(result.warnings.join(" ")).toContain("ledger ownership could not be updated");
    expect(result.results[0]!.newThreadId).toBeTruthy();
    expect(result.results[0]!.newThreadId).not.toBe(fixture.threadId);
    const newThreadId = result.results[0]!.newThreadId!;
    const committedEvents = eventCount(fixture.dbPath);
    expect(committedEvents).toBeGreaterThan(before);
    const backupDirectory = join(paths.stateDir, "t3-import-backups");
    expect(readdirSync(backupDirectory).filter((name) => name.startsWith("replacement-") && name.endsWith(".json"))).toHaveLength(1);
    const interruptedLedger = new Database(ledgerPath, { readonly: true });
    try {
      expect(interruptedLedger.prepare("SELECT target_id targetId, backup_path backupPath, is_canonical canonical FROM imports WHERE thread_id = ?").get(fixture.threadId))
        .toEqual({ targetId: oldRecord.targetId, backupPath: oldRecord.backupPath, canonical: 1 });
      expect(interruptedLedger.prepare("SELECT COUNT(*) count FROM imports WHERE thread_id = ?").get(newThreadId))
        .toMatchObject({ count: 0 });
    } finally { interruptedLedger.close(); }
    const db = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT deleted_at deletedAt FROM orchestration_v2_projection_threads WHERE thread_id = ?").get(fixture.threadId))
        .toMatchObject({ deletedAt: expect.any(String) });
    } finally { db.close(); }

    const writableLedger = new Database(ledgerPath);
    writableLedger.exec("DROP TRIGGER reject_upgrade_replacement_ledger;");
    writableLedger.close();
    const retry = await replaceConversations([{ conversation }], paths, { dryRun: false });
    expect(retry.results[0]).toMatchObject({ status: "already-current", oldThreadId: fixture.threadId, newThreadId });
    expect(eventCount(fixture.dbPath)).toBe(committedEvents);
    const recoveredLedger = new Database(ledgerPath, { readonly: true });
    try {
      const rows = recoveredLedger.prepare("SELECT target_id targetId, thread_id threadId, backup_path backupPath, is_canonical canonical, superseded_by_thread_id supersededBy FROM imports ORDER BY imported_at").all();
      expect(rows).toEqual([
        { targetId: oldRecord.targetId, threadId: fixture.threadId, backupPath: oldRecord.backupPath, canonical: 0, supersededBy: newThreadId },
        { targetId: sha256(canonicalPath(fixture.dbPath)), threadId: newThreadId, backupPath: result.backup, canonical: 1, supersededBy: null },
      ]);
    } finally { recoveredLedger.close(); }
    const backup = new Database(result.backup!, { readonly: true, fileMustExist: true });
    try {
      expect(backup.prepare("SELECT deleted_at deletedAt FROM orchestration_v2_projection_threads WHERE thread_id = ?").get(fixture.threadId))
        .toEqual({ deletedAt: null });
      expect(backup.prepare("SELECT COUNT(*) count FROM orchestration_v2_projection_threads WHERE thread_id = ?").get(newThreadId))
        .toMatchObject({ count: 0 });
    } finally { backup.close(); }
    expect(readdirSync(backupDirectory).filter((name) => name.startsWith("replacement-") && name.endsWith(".json"))).toEqual([]);
  });
});
