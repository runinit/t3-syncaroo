import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalConversation, canonicalThread, eventCount } from "./helpers.js";
import { resolveTargetPaths } from "../src/target/config.js";
import { importConversations } from "../src/target/importer.js";
import { recordImports, listImports, type LedgerRecord } from "../src/target/ledger.js";
import { checkpointForThread } from "../src/core/checkpoint.js";
import { canonicalPath, sha256 } from "../src/core/util.js";

const t3SourceDir = process.env.T3_V2_T3_SOURCE_DIR;
const t3DependencyRoot = process.env.T3_V2_T3_DEPENDENCY_ROOT;
const fixtureRunner = fileURLToPath(new URL("../scripts/compatibility/v2-native/legacy-upgrade-fixture.mjs", import.meta.url));
const nativeHelper = fileURLToPath(new URL("../vendor/t3-v2-native-helper.mjs", import.meta.url));
const originalLedgerDir = process.env.T3_IMPORT_DATA_DIR;

afterEach(() => {
  if (originalLedgerDir === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedgerDir;
});

describe.skipIf(!t3SourceDir || !existsSync(t3SourceDir))("public import reconciliation after native upgrade", () => {
  it("recognizes and safely binds an exact converted import without replaying its transcript", async () => {
    const tempRoot = join(process.cwd(), "node_modules/.cache");
    mkdirSync(tempRoot, { recursive: true });
    const root = await mkdtemp(join(tempRoot, "t3-v2-upgrade-public-"));
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
    thread.turns[0]!.completedAt = thread.updatedAt;
    thread.turns[0]!.user.sourceId = "legacy-message-06-user";
    thread.turns[0]!.user.text = "Question";
    thread.turns[0]!.user.timestamp = "2026-01-01T00:00:00.000Z";
    thread.turns[0]!.assistant = [{ sourceId: "legacy-message-06-assistant", role: "assistant", text: "Answer", timestamp: "2026-01-01T00:00:01.000Z", attachments: [] }];
    thread.turns[0]!.activities = [];
    const conversation = canonicalConversation(workspace, thread);
    const before = eventCount(fixture.dbPath);

    const first = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
    expect(first.results[0]).toMatchObject({ status: "already-imported", threadId: fixture.threadId, resumable: true });
    const afterAttach = eventCount(fixture.dbPath);
    const inspect = JSON.parse(execFileSync(process.execPath, [nativeHelper], {
      input: JSON.stringify({ op: "inspect", dbPath: fixture.dbPath, threadIds: [fixture.threadId] }), encoding: "utf8",
    })) as { threads: Array<{ records: { messages: Array<Record<string, unknown>>; providerThreads: Array<Record<string, unknown>> } }> };
    expect(afterAttach).toBeGreaterThan(before);
    expect(inspect.threads[0]!.records.messages).toHaveLength(2);
    expect(inspect.threads[0]!.records.providerThreads).toHaveLength(1);
    expect(inspect.threads[0]!.records.providerThreads[0]).toMatchObject({
      nativeThreadRef: { driver: "codex", nativeId: fixture.threadId, strength: "strong" },
    });

    const repeated = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
    expect(repeated.results[0]!.status).toBe("already-imported");
    expect(eventCount(fixture.dbPath)).toBe(afterAttach);
    const ledger = new Database(join(ledgerDir, "ledger.sqlite"), { readonly: true });
    try {
      expect(ledger.prepare("SELECT source_session_id, thread_id FROM imports WHERE thread_id = ?").get(fixture.threadId))
        .toMatchObject({ source_session_id: fixture.threadId, thread_id: fixture.threadId });
    } finally { ledger.close(); }
  });

  it("retains an old Claude mapping and source assistant head while attaching the converted shell", async () => {
    const tempRoot = join(process.cwd(), "node_modules/.cache");
    mkdirSync(tempRoot, { recursive: true });
    const root = await mkdtemp(join(tempRoot, "t3-v2-upgrade-claude-"));
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
    const importedSourceKey = `claude:${sourceSessionId}:assistant-head-06`;
    const sourceKey = `claude:${sourceSessionId}:assistant-head-07`;
    const thread = canonicalThread(workspace);
    thread.source = "claude";
    thread.sourceSessionId = sourceSessionId;
    thread.sourceKey = importedSourceKey;
    thread.leafId = "assistant-head-06";
    thread.model = "claude-test";
    thread.createdAt = "2026-01-01T00:00:00.000Z";
    thread.updatedAt = "2026-01-01T00:00:02.000Z";
    thread.resumeCursor = { resume: sourceSessionId, resumeSessionAt: "assistant-head-06" };
    thread.turns[0]!.completedAt = thread.updatedAt;
    thread.turns[0]!.user.sourceId = "legacy-message-06-user";
    thread.turns[0]!.user.text = "Question";
    thread.turns[0]!.user.timestamp = "2026-01-01T00:00:00.000Z";
    thread.turns[0]!.assistant = [{ sourceId: "legacy-message-06-assistant", role: "assistant", text: "Answer", timestamp: "2026-01-01T00:00:01.000Z", attachments: [] }];
    thread.turns[0]!.activities = [];
    const importedCheckpoint = checkpointForThread(thread);
    thread.turns.push({
      ...thread.turns[0]!, id: "claude-turn-07", startedAt: "2026-01-01T00:00:03.000Z",
      completedAt: "2026-01-01T00:00:05.000Z", user: { ...thread.turns[0]!.user, sourceId: "claude-user-07", text: "Follow-up", timestamp: "2026-01-01T00:00:03.000Z" },
      assistant: [{ sourceId: "claude-assistant-07", role: "assistant", text: "Follow-up answer", timestamp: "2026-01-01T00:00:04.000Z", attachments: [] }],
    });
    thread.sourceKey = sourceKey;
    thread.leafId = "assistant-head-07";
    thread.resumeCursor = { resume: sourceSessionId, resumeSessionAt: "assistant-head-07" };
    thread.updatedAt = "2026-01-01T00:00:05.000Z";
    const conversation = canonicalConversation(workspace, thread);
    const legacyTargetId = sha256(canonicalPath(join(paths.stateDir, "state.sqlite")));
    const legacyRow: LedgerRecord = {
      targetId: legacyTargetId, source: "claude", sourceSessionId, sourceKey: importedSourceKey,
      sourceFingerprint: conversation.fingerprint, projectId: "project-06", threadId: fixture.threadId,
      importedAt: "2026-02-01T00:00:00.000Z", importerVersion: "0.3.0", migration: 52,
      firstSequence: 1, lastSequence: 7, resumable: true, backupPath: join(root, "legacy-backup.sqlite"),
      warnings: [], identitySeed: importedSourceKey, currentSourceKey: importedSourceKey, sourceLeafId: "assistant-head-06",
      nativeConversationHeadId: "assistant-head-06", sourceTitle: thread.title,
      checkpoint: importedCheckpoint, isCanonical: true,
    };
    recordImports([legacyRow]);

    const result = await importConversations([{ conversation, resume: true }], paths,
      { dryRun: false, resume: true, providerInstance: "claudeAgent" });
    expect(result.results[0]).toMatchObject({ status: "already-imported", threadId: fixture.threadId, resumable: true });
    const inspect = JSON.parse(execFileSync(process.execPath, [nativeHelper], {
      input: JSON.stringify({ op: "inspect", dbPath: fixture.dbPath, threadIds: [fixture.threadId] }), encoding: "utf8",
    })) as { threads: Array<{ records: { providerThreads: Array<Record<string, unknown>> } }> };
    expect(inspect.threads[0]!.records.providerThreads).toContainEqual(expect.objectContaining({
      driver: "claudeAgent", providerInstanceId: "claudeAgent",
      nativeThreadRef: { driver: "claudeAgent", nativeId: sourceSessionId, strength: "strong" },
      nativeConversationHeadRef: { driver: "claudeAgent", nativeId: "assistant-head-07", strength: "strong" },
    }));
    const copied = listImports(sha256(canonicalPath(fixture.dbPath)), "claude").find((row) => row.threadId === fixture.threadId)!;
    expect(copied).toMatchObject({ sourceLeafId: "assistant-head-07", nativeConversationHeadId: "assistant-head-07", resumable: true,
      backupPath: legacyRow.backupPath, checkpoint: { version: 2, nativeProjection: { kind: "semantic-native-prefix-v1" } } });
    expect(copied.checkpoint?.turns).toHaveLength(1);
    expect(listImports(legacyTargetId, "claude")).toContainEqual(expect.objectContaining({
      threadId: fixture.threadId, backupPath: legacyRow.backupPath, sourceLeafId: "assistant-head-06",
    }));
  });

  it("preserves an old mapping's resume opt-out when attaching a converted shell", async () => {
    const tempRoot = join(process.cwd(), "node_modules/.cache");
    mkdirSync(tempRoot, { recursive: true });
    const root = await mkdtemp(join(tempRoot, "t3-v2-upgrade-optout-"));
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
    thread.turns[0]!.completedAt = thread.updatedAt;
    thread.turns[0]!.user.sourceId = "legacy-message-06-user";
    thread.turns[0]!.user.text = "Question";
    thread.turns[0]!.user.timestamp = "2026-01-01T00:00:00.000Z";
    thread.turns[0]!.assistant = [{ sourceId: "legacy-message-06-assistant", role: "assistant", text: "Answer", timestamp: "2026-01-01T00:00:01.000Z", attachments: [] }];
    thread.turns[0]!.activities = [];
    const conversation = canonicalConversation(workspace, thread);
    const legacyTargetId = sha256(canonicalPath(join(paths.stateDir, "state.sqlite")));
    recordImports([{
      targetId: legacyTargetId, source: "codex", sourceSessionId: thread.sourceSessionId, sourceKey: thread.sourceKey,
      sourceFingerprint: conversation.fingerprint, projectId: "project-06", threadId: fixture.threadId,
      importedAt: "2026-02-01T00:00:00.000Z", importerVersion: "0.3.0", migration: 52,
      firstSequence: 1, lastSequence: 7, resumable: false, backupPath: join(root, "legacy-backup.sqlite"),
      warnings: ["Resuming was disabled by the original import."], identitySeed: thread.sourceKey,
      currentSourceKey: thread.sourceKey, sourceTitle: thread.title, checkpoint: checkpointForThread(thread), isCanonical: true,
    }]);
    const result = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
    expect(result.results[0]).toMatchObject({ status: "already-imported", threadId: fixture.threadId, resumable: false });
    const inspect = JSON.parse(execFileSync(process.execPath, [nativeHelper], {
      input: JSON.stringify({ op: "inspect", dbPath: fixture.dbPath, threadIds: [fixture.threadId] }), encoding: "utf8",
    })) as { threads: Array<{ records: { providerThreads: Array<Record<string, unknown>> } }> };
    expect(inspect.threads[0]!.records.providerThreads).toContainEqual(expect.objectContaining({
      nativeThreadRef: null, nativeConversationHeadRef: null,
    }));
    expect(listImports(sha256(canonicalPath(fixture.dbPath)), "codex")).toContainEqual(expect.objectContaining({
      threadId: fixture.threadId, resumable: false, backupPath: join(root, "legacy-backup.sqlite"),
    }));
  });

  it("reports ambiguous source mappings for one task and still imports an unrelated task", async () => {
    const tempRoot = join(process.cwd(), "node_modules/.cache");
    mkdirSync(tempRoot, { recursive: true });
    const root = await mkdtemp(join(tempRoot, "t3-v2-upgrade-conflict-"));
    const workspace = join(root, "source-workspace");
    const unrelatedWorkspace = join(root, "unrelated-workspace");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(unrelatedWorkspace, { recursive: true });
    const fixtureOut = execFileSync(process.execPath, [fixtureRunner, root], {
      env: { ...process.env, T3_V2_T3_SOURCE_DIR: t3SourceDir!,
        ...(t3DependencyRoot ? { T3_V2_T3_DEPENDENCY_ROOT: t3DependencyRoot } : {}),
        T3_V2_UPGRADE_WORKSPACE: workspace }, encoding: "utf8",
    }).trim().split("\n").at(-1)!;
    const fixture = JSON.parse(fixtureOut) as { dbPath: string; threadId: string };
    const ledgerDir = join(root, "ledger");
    process.env.T3_IMPORT_DATA_DIR = ledgerDir;
    const paths = resolveTargetPaths({ dbPath: fixture.dbPath });
    const sourceThread = canonicalThread(workspace);
    sourceThread.sourceSessionId = fixture.threadId;
    sourceThread.sourceKey = `codex:${fixture.threadId}`;
    sourceThread.model = "gpt-5.4";
    sourceThread.createdAt = "2026-01-01T00:00:00.000Z";
    sourceThread.updatedAt = "2026-01-01T00:00:02.000Z";
    sourceThread.turns[0]!.completedAt = sourceThread.updatedAt;
    sourceThread.turns[0]!.user.sourceId = "legacy-message-06-user";
    sourceThread.turns[0]!.user.text = "Question";
    sourceThread.turns[0]!.user.timestamp = "2026-01-01T00:00:00.000Z";
    sourceThread.turns[0]!.assistant = [{ sourceId: "legacy-message-06-assistant", role: "assistant", text: "Answer", timestamp: "2026-01-01T00:00:01.000Z", attachments: [] }];
    sourceThread.turns[0]!.activities = [];
    const sourceConversation = canonicalConversation(workspace, sourceThread);
    recordImports([{
      targetId: sha256(canonicalPath(join(paths.stateDir, "state.sqlite"))), source: "codex",
      sourceSessionId: sourceThread.sourceSessionId, sourceKey: sourceThread.sourceKey,
      sourceFingerprint: sourceConversation.fingerprint, projectId: "wrong-project", threadId: fixture.threadId,
      importedAt: "2026-02-01T00:00:00.000Z", importerVersion: "0.3.0", migration: 52,
      firstSequence: 1, lastSequence: 7, resumable: true, backupPath: join(root, "legacy-backup.sqlite"),
      warnings: [], identitySeed: sourceThread.sourceKey, currentSourceKey: sourceThread.sourceKey,
      sourceTitle: sourceThread.title, checkpoint: checkpointForThread(sourceThread), isCanonical: true,
    }, {
      targetId: sha256(canonicalPath(join(paths.stateDir, "state.sqlite"))), source: "codex",
      sourceSessionId: sourceThread.sourceSessionId, sourceKey: `codex:${sourceThread.sourceSessionId}:other`,
      sourceFingerprint: sourceConversation.fingerprint, projectId: "other-project", threadId: "22222222-2222-4222-8222-222222222222",
      importedAt: "2026-02-01T00:00:01.000Z", importerVersion: "0.3.0", migration: 52,
      firstSequence: 1, lastSequence: 7, resumable: true, backupPath: join(root, "other-backup.sqlite"),
      warnings: [], identitySeed: `codex:${sourceThread.sourceSessionId}:other`, currentSourceKey: `codex:${sourceThread.sourceSessionId}:other`,
      sourceTitle: sourceThread.title, checkpoint: checkpointForThread(sourceThread), isCanonical: true,
    }]);
    const unrelated = canonicalThread(unrelatedWorkspace);
    unrelated.sourceSessionId = "codex-unrelated-06";
    unrelated.sourceKey = "codex:codex-unrelated-06";
    const unrelatedConversation = canonicalConversation(unrelatedWorkspace, unrelated);
    const before = eventCount(fixture.dbPath);

    const result = await importConversations([
      { conversation: sourceConversation, resume: true },
      { conversation: unrelatedConversation, resume: true },
    ], paths, { dryRun: false, resume: true });
    expect(result.results.map((item) => item.status)).toEqual(["conflict", "imported"]);
    expect(result.results[0]!.warnings.join(" ")).toContain("More than one active importer mapping");
    expect(eventCount(fixture.dbPath)).toBeGreaterThan(before);
    expect(listImports(sha256(canonicalPath(fixture.dbPath)), "codex")).toContainEqual(expect.objectContaining({
      sourceSessionId: "codex-unrelated-06",
    }));
    const inspect = JSON.parse(execFileSync(process.execPath, [nativeHelper], {
      input: JSON.stringify({ op: "inspect", dbPath: fixture.dbPath, threadIds: [fixture.threadId] }), encoding: "utf8",
    })) as { threads: Array<{ records: { providerThreads: Array<Record<string, unknown>> } }> };
    expect(inspect.threads[0]!.records.providerThreads).toHaveLength(0);
  });
});
