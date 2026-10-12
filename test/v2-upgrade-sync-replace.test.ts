import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkpointForThread } from "../src/core/checkpoint.js";
import { canonicalPath, deterministicUuid, sha256 } from "../src/core/util.js";
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
      T3_V2_UPGRADE_WORKSPACE: workspace,
      T3_V2_UPGRADE_IMAGE_BYTES_BASE64: Buffer.from("png-bytes").toString("base64") }, encoding: "utf8",
  }).trim().split("\n").at(-1)!;
  const fixture = JSON.parse(fixtureOut) as { dbPath: string; threadId: string; imageAttachmentId: string; imageSourceId: string };
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
  thread.turns[0]!.user.attachments = [{ sourceId: fixture.imageSourceId, name: "proof.png", mimeType: "image/png", sizeBytes: 9, data: Buffer.from("png-bytes") }];
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
  it.each(["matching", "changed history", "wrong project"])("recovers a historical Claude task conservatively with %s", async (scenario) => {
    const tempRoot = join(process.cwd(), "node_modules/.cache");
    mkdirSync(tempRoot, { recursive: true });
    const root = await mkdtemp(join(tempRoot, "t3-v2-upgrade-claude-missing-ledger-"));
    const workspace = join(root, "source-workspace");
    mkdirSync(workspace, { recursive: true });
    const sourceSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const originalHead = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const currentHead = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const originalThreadId = deterministicUuid(`t3-import:thread:claude:${sourceSessionId}:${originalHead}`);
    const fixtureOut = execFileSync(process.execPath, [fixtureRunner, root], {
      env: { ...process.env, T3_V2_T3_SOURCE_DIR: t3SourceDir!,
        ...(t3DependencyRoot ? { T3_V2_T3_DEPENDENCY_ROOT: t3DependencyRoot } : {}),
        T3_V2_UPGRADE_WORKSPACE: workspace, T3_V2_UPGRADE_PROVIDER_INSTANCE: "claudeAgent",
        T3_V2_UPGRADE_THREAD_ID: originalThreadId }, encoding: "utf8",
    }).trim().split("\n").at(-1)!;
    const fixture = JSON.parse(fixtureOut) as { dbPath: string; threadId: string };
    const ledgerDir = join(root, "ledger");
    process.env.T3_IMPORT_DATA_DIR = ledgerDir;
    const paths = resolveTargetPaths({ dbPath: fixture.dbPath });
    const sourceThread = canonicalThread(workspace);
    sourceThread.source = "claude";
    sourceThread.sourceSessionId = sourceSessionId;
    sourceThread.sourceKey = `claude:${sourceSessionId}:${currentHead}`;
    sourceThread.leafId = currentHead;
    sourceThread.model = "claude-test";
    sourceThread.createdAt = "2026-01-01T00:00:00.000Z";
    sourceThread.updatedAt = "2026-01-01T00:00:02.000Z";
    sourceThread.resumeCursor = { resume: sourceSessionId, resumeSessionAt: currentHead };
    sourceThread.turns[0]!.completedAt = sourceThread.updatedAt;
    sourceThread.turns[0]!.user.sourceId = "legacy-message-06-user";
    sourceThread.turns[0]!.user.text = "Question";
    sourceThread.turns[0]!.user.timestamp = "2026-01-01T00:00:00.000Z";
    sourceThread.turns[0]!.assistant = [{ sourceId: `${originalHead}:text:0`, role: "assistant", text: "Answer", timestamp: "2026-01-01T00:00:01.000Z", attachments: [] }];
    sourceThread.turns[0]!.activities = [];
    appendFollowup(sourceThread);
    sourceThread.turns[1]!.assistant[0]!.sourceId = `${currentHead}:text:0`;
    const conversation = canonicalConversation(workspace, sourceThread);
    if (scenario !== "matching") {
      const db = new Database(fixture.dbPath);
      try {
        if (scenario === "changed history") db.prepare("UPDATE orchestration_v2_projection_messages SET payload_json = json_set(payload_json, '$.text', 'Changed in T3') WHERE thread_id = ? AND role = 'assistant'").run(fixture.threadId);
        else db.prepare("UPDATE orchestration_v2_projection_threads SET project_id = 'other-project', payload_json = json_set(payload_json, '$.projectId', 'other-project') WHERE thread_id = ?").run(fixture.threadId);
      } finally { db.close(); }
    }
    const before = eventCount(fixture.dbPath);
    const result = await importConversations([{ conversation, resume: true }], paths,
      { dryRun: false, resume: true, providerInstance: "claudeAgent" });

    if (scenario !== "matching") {
      expect(result.results[0]).toMatchObject({ status: "conflict", threadId: fixture.threadId });
      expect(eventCount(fixture.dbPath)).toBe(before);
      return;
    }
    expect(result.results[0]).toMatchObject({ status: "already-imported", threadId: fixture.threadId });
    expect(eventCount(fixture.dbPath)).toBeLessThanOrEqual(before + 1);
    const db = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) count FROM orchestration_v2_projection_threads WHERE project_id = 'project-06'").get())
        .toMatchObject({ count: 1 });
    } finally { db.close(); }
  });

  it("previews converted sync without attaching, and refuses edited source history", async () => {
    const { fixture, paths, thread } = await upgradedCodexFixture("t3-v2-upgrade-sync-preview-");
    appendFollowup(thread);
    const conversation = canonicalConversation(thread.workspace, thread);
    const before = eventCount(fixture.dbPath);
    const preview = await syncConversations([{ conversation }], paths, { dryRun: true });
    expect(preview.results[0]).toMatchObject({ status: "dry-run", turnsAdded: 1 });
    expect(eventCount(fixture.dbPath)).toBe(before);
    thread.turns[0]!.assistant[0]!.text = "Edited imported source history";
    const conflict = await syncConversations([{ conversation }], paths, { dryRun: false });
    expect(conflict.results[0]).toMatchObject({ status: "history-diverged" });
    expect(eventCount(fixture.dbPath)).toBe(before);
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
      expect(db.prepare("SELECT COUNT(*) count FROM orchestration_v2_projection_messages WHERE thread_id = ?").get(fixture.threadId))
        .toMatchObject({ count: 4 });
    } finally { db.close(); }
    const currentRecord = listImports(sha256(canonicalPath(fixture.dbPath)), "codex").find((record) => record.threadId === fixture.threadId);
    expect(currentRecord).toBeDefined();
    expect(currentRecord!.firstSequence).not.toBe(oldRecord.firstSequence);
    expect(currentRecord!.lastSequence).not.toBe(oldRecord.lastSequence);
  });

  it("restores a missing converted image only from the verified canonical source bytes", async () => {
    const { root, fixture, paths, thread } = await upgradedCodexFixture("t3-v2-upgrade-image-recovery-");
    const assetPath = join(paths.attachmentsDir, `${fixture.imageAttachmentId}.png`);
    const bytes = Buffer.from("png-bytes");
    expect(readFileSync(assetPath)).toEqual(bytes);
    rmSync(assetPath);
    rmSync(join(root, "ledger"), { recursive: true, force: true });
    const before = eventCount(fixture.dbPath);

    const result = await importConversations([{ conversation: canonicalConversation(thread.workspace, thread), resume: true }], paths,
      { dryRun: false, resume: true });

    expect(result.results[0]).toMatchObject({ status: "already-imported", threadId: fixture.threadId });
    expect(readFileSync(assetPath)).toEqual(bytes);
    // Repairing the binding adds one event; the converted transcript is not replayed.
    expect(eventCount(fixture.dbPath)).toBe(before + 1);
    const repeated = await importConversations([{ conversation: canonicalConversation(thread.workspace, thread), resume: true }], paths,
      { dryRun: false, resume: true });
    expect(repeated.results[0]).toMatchObject({ status: "already-imported", threadId: fixture.threadId });
    expect(eventCount(fixture.dbPath)).toBe(before + 1);
  });

  it("replaces a converted task addressed only by its old-target ledger row", async () => {
    const { fixture, paths, thread } = await upgradedCodexFixture("t3-v2-upgrade-replace-");
    appendFollowup(thread);
    const conversation = canonicalConversation(thread.workspace, thread);

    const result = await replaceConversations([{ conversation }], paths, { dryRun: false });

    expect(result.results[0]).toMatchObject({ status: "replaced", oldThreadId: fixture.threadId });
    expect(result.results[0]!.newThreadId).toBeTruthy();
    expect(result.results[0]!.newThreadId).not.toBe(fixture.threadId);
    const db = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT deleted_at deletedAt FROM orchestration_v2_projection_threads WHERE thread_id = ?").get(fixture.threadId))
        .toMatchObject({ deletedAt: expect.any(String) });
    } finally { db.close(); }
  });
});
