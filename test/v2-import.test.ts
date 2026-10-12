import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalConversation, canonicalThread, eventCount } from "./helpers.js";
import { resolveTargetPaths } from "../src/target/config.js";
import { importConversations } from "../src/target/importer.js";
import { inspectConversationSync, syncConversations } from "../src/target/sync.js";
import { deterministicUuid } from "../src/core/util.js";

const fixture = process.env.T3_V2_FIXTURE_DB;
const helper = fileURLToPath(new URL("../vendor/t3-v2-native-helper.mjs", import.meta.url));
const originalLedgerDir = process.env.T3_IMPORT_DATA_DIR;

afterEach(() => {
  if (originalLedgerDir === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedgerDir;
});

describe.skipIf(!fixture || !existsSync(fixture))("pinned T3 nightly v2 import", () => {
  it("does not create a native continuation binding when resume was declined", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-v2-no-resume-"));
    const workspace = join(root, "workspace");
    const dbPath = join(root, "userdata", "statev2.sqlite");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(root, "userdata"), { recursive: true });
    copyFileSync(fixture!, dbPath);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const paths = resolveTargetPaths({ dbPath });
    const thread = canonicalThread(workspace);
    thread.turns[0]!.activities = [];
    const result = await importConversations([{ conversation: canonicalConversation(workspace, thread), resume: false }], paths, { dryRun: false, resume: false });
    expect(result.results[0]!.resumable).toBe(false);
    const inspected = JSON.parse(execFileSync(process.execPath, [helper], {
      input: JSON.stringify({ op: "inspect", dbPath, threadIds: [result.results[0]!.threadId] }),
      encoding: "utf8",
    })) as { threads: Array<{ records: { providerThreads: Array<{ nativeThreadRef: unknown; nativeConversationHeadRef: unknown }> } }> };
    expect(inspected.threads[0]!.records.providerThreads).toHaveLength(1);
    expect(inspected.threads[0]!.records.providerThreads[0]).toMatchObject({ nativeThreadRef: null, nativeConversationHeadRef: null });
  });

  it("synchronizes only settled source turns through the native v2 path", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-v2-sync-"));
    const workspace = join(root, "workspace");
    const dbPath = join(root, "userdata", "statev2.sqlite");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(root, "userdata"), { recursive: true });
    copyFileSync(fixture!, dbPath);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const paths = resolveTargetPaths({ dbPath });
    const original = canonicalThread(workspace);
    original.turns[0]!.activities = [];
    const initial = canonicalConversation(workspace, original);
    const imported = await importConversations([{ conversation: initial, resume: true }], paths, { dryRun: false, resume: true });
    expect(imported.status).toBe("imported");

    const updated = structuredClone(original);
    const next = structuredClone(updated.turns[0]!);
    next.id = "turn-v2-sync-2";
    next.user.sourceId = "user-v2-sync-2";
    next.user.text = "Continue from the original session";
    next.assistant[0]!.sourceId = "assistant-v2-sync-2";
    next.assistant[0]!.text = "The original session continued";
    updated.turns.push(next);
    const active = structuredClone(next);
    active.id = "turn-v2-sync-active";
    active.user.sourceId = "user-v2-sync-active";
    active.assistant[0]!.sourceId = "assistant-v2-sync-active";
    active.status = "inProgress";
    delete active.completedAt;
    updated.turns.push(active);
    const advanced = canonicalConversation(workspace, updated);

    expect(await inspectConversationSync(advanced, paths)).toMatchObject({ status: "syncable", newTurns: 1, ignoredActiveTurns: 1 });
    const before = eventCount(dbPath);
    const first = await syncConversations([{ conversation: advanced }], paths, { dryRun: false });
    expect(first.results[0]).toMatchObject({ status: "synced", turnsAdded: 1 });
    const after = eventCount(dbPath);
    expect(after).toBeGreaterThan(before);
    const repeated = await syncConversations([{ conversation: advanced }], paths, { dryRun: false });
    expect(repeated.results[0]).toMatchObject({ status: "up-to-date", turnsAdded: 0, events: 0 });
    expect(eventCount(dbPath)).toBe(after);
  });

  it("continues a Claude session as its source leaf advances", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-v2-claude-sync-"));
    const workspace = join(root, "workspace");
    const dbPath = join(root, "userdata", "statev2.sqlite");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(root, "userdata"), { recursive: true });
    copyFileSync(fixture!, dbPath);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const paths = resolveTargetPaths({ dbPath });
    const thread = canonicalThread(workspace);
    const sessionId = "claude-session-04";
    thread.source = "claude";
    thread.sourceSessionId = sessionId;
    thread.leafId = "leaf-before";
    thread.sourceKey = `claude:${sessionId}:leaf-before`;
    thread.resumeCursor = { resumeSessionAt: "leaf-before" };
    const initial = canonicalConversation(workspace, thread);
    initial.summary.source = "claude";
    initial.summary.id = sessionId;
    const imported = await importConversations([{ conversation: initial, resume: true }], paths, { dryRun: false, resume: true });
    expect(imported.results[0]!.resumable).toBe(true);

    const advanced = structuredClone(thread);
    advanced.leafId = "leaf-after";
    advanced.sourceKey = `claude:${sessionId}:leaf-after`;
    advanced.resumeCursor = { resumeSessionAt: "leaf-after" };
    advanced.updatedAt = "2026-01-01T00:00:08.000Z";
    const next = structuredClone(thread.turns[0]!);
    next.id = "claude-turn-2";
    next.user.sourceId = "claude-user-2";
    next.user.text = "Continue";
    next.assistant[0]!.sourceId = "claude-assistant-2";
    next.assistant[0]!.text = "Continued";
    next.activities = [];
    advanced.turns.push(next);
    const advancedConversation = canonicalConversation(workspace, advanced);
    advancedConversation.summary.source = "claude";
    advancedConversation.summary.id = sessionId;
    advancedConversation.summary.branches = 2;
    advancedConversation.summary.updatedAt = advanced.updatedAt;
    const alternate = structuredClone(thread);
    alternate.currentBranch = false;
    alternate.leafId = "alternate-leaf";
    alternate.sourceKey = `claude:${sessionId}:alternate-leaf`;
    advancedConversation.threads.push(alternate);
    const synced = await syncConversations([{ conversation: advancedConversation }], paths, { dryRun: false });
    expect(synced.results[0]).toMatchObject({ status: "synced", turnsAdded: 1, resumable: true });
    const inspected = JSON.parse(execFileSync(process.execPath, [helper], {
      input: JSON.stringify({ op: "inspect", dbPath, threadIds: [imported.results[0]!.threadId] }),
      encoding: "utf8",
    })) as { threads: Array<{ records: { providerThreads: Array<{ nativeThreadRef: { nativeId: string }; nativeConversationHeadRef: { nativeId: string } }> } }> };
    expect(inspected.threads[0]!.records.providerThreads[0]).toMatchObject({
      nativeThreadRef: { nativeId: sessionId }, nativeConversationHeadRef: { nativeId: "leaf-after" },
    });
    const beforeAmbiguousSync = eventCount(dbPath);
    const ambiguous = structuredClone(advancedConversation);
    ambiguous.threads[1]!.currentBranch = true;
    const rejected = await syncConversations([{ conversation: ambiguous }], paths, { dryRun: false });
    expect(rejected.results[0]!.status).toBe("branch-sync-unsupported");
    expect(eventCount(dbPath)).toBe(beforeAmbiguousSync);

    const untrusted = structuredClone(advancedConversation);
    untrusted.threads.forEach((candidate) => { candidate.currentBranch = false; });
    untrusted.threads[0]!.warnings = ["The source current leaf is not uniquely identified."];
    untrusted.threads[0]!.turns[0]!.assistant[0]!.text = "Changed ambiguous history";
    const untrustedResult = await syncConversations([{ conversation: untrusted }], paths, { dryRun: false });
    expect(untrustedResult.results[0]!.status).toBe("branch-sync-unsupported");
    expect(untrustedResult.results[0]!.warnings).toContain("The source current leaf is not uniquely identified.");
    expect(eventCount(dbPath)).toBe(beforeAmbiguousSync);
  });

  it("reports edited or deleted imported source history without modifying the native task", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-v2-sync-conflict-"));
    const workspace = join(root, "workspace");
    const dbPath = join(root, "userdata", "statev2.sqlite");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(root, "userdata"), { recursive: true });
    copyFileSync(fixture!, dbPath);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const paths = resolveTargetPaths({ dbPath });
    const original = canonicalThread(workspace);
    original.turns[0]!.activities = [];
    await importConversations([{ conversation: canonicalConversation(workspace, original), resume: true }], paths, { dryRun: false, resume: true });
    const edited = structuredClone(original);
    edited.turns[0]!.user.text = "An edit to imported history";
    const next = structuredClone(edited.turns[0]!);
    next.id = "turn-v2-conflict-next";
    next.user.sourceId = "user-v2-conflict-next";
    next.assistant[0]!.sourceId = "assistant-v2-conflict-next";
    edited.turns.push(next);
    const before = eventCount(dbPath);

    const preview = await inspectConversationSync(canonicalConversation(workspace, edited), paths);
    expect(preview).toMatchObject({ status: "history-diverged", previouslyImported: true, selectable: false });
    const deleted = structuredClone(original);
    deleted.turns = [];
    const deletedResult = await syncConversations([{ conversation: canonicalConversation(workspace, deleted) }], paths, { dryRun: false });
    expect(deletedResult.results[0]!.status).toBe("history-diverged");
    expect(eventCount(dbPath)).toBe(before);
    const result = await syncConversations([{ conversation: canonicalConversation(workspace, edited) }], paths, { dryRun: false });
    expect(result).toMatchObject({ status: "conflict", hasConflicts: true, backup: null });
    expect(result.results[0]!.status).toBe("history-diverged");
    expect(eventCount(dbPath)).toBe(before);
  });

  it("writes, reopens, safely retries, and rejects divergent history through the public importer", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-v2-public-"));
    const workspace = join(root, "workspace");
    const dbPath = join(root, "userdata", "statev2.sqlite");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(root, "userdata"), { recursive: true });
    copyFileSync(fixture!, dbPath);
    const blockedLedger = join(root, "ledger-is-a-file");
    writeFileSync(blockedLedger, "block ledger creation after native commit");
    process.env.T3_IMPORT_DATA_DIR = blockedLedger;
    const paths = resolveTargetPaths({ dbPath });
    const thread = canonicalThread(workspace);
    thread.turns[0]!.activities = [];
    const selection = { conversation: canonicalConversation(workspace, thread), resume: true };

    const options = { dryRun: false, resume: true, providerInstance: "codex-alt" };
    const initialEventCount = eventCount(dbPath);
    const blocked = await importConversations([selection], paths, options);
    expect(blocked.status).toBe("mixed");
    expect(blocked.results[0]).toMatchObject({ status: "conflict", warnings: expect.arrayContaining([expect.stringContaining("external import mapping could not be checked")]) });
    expect(blocked.backup).toBeNull();
    expect(eventCount(dbPath)).toBe(initialEventCount);
    const ledgerDir = join(root, "ledger");
    mkdirSync(ledgerDir);
    process.env.T3_IMPORT_DATA_DIR = ledgerDir;
    const first = await importConversations([selection], paths, options);
    expect(first.status).toBe("imported");
    expect(first.backup && existsSync(first.backup)).toBe(true);
    const eventTotal = eventCount(dbPath);
    const providerConflict = await importConversations([selection], paths, { dryRun: false, resume: true });
    expect(providerConflict.results[0]).toMatchObject({ status: "conflict", warnings: expect.arrayContaining([expect.stringContaining("project/provider ownership")] ) });
    expect(eventCount(dbPath)).toBe(eventTotal);
    const retry = await importConversations([selection], paths, options);
    expect(retry.status).toBe("already-imported");
    expect(eventCount(dbPath)).toBe(eventTotal);

    const inspect = JSON.parse(execFileSync(process.execPath, [helper], {
      input: JSON.stringify({ op: "inspect", dbPath, threadIds: [first.results[0]!.threadId], projectIds: [first.results[0]!.projectId] }),
      encoding: "utf8",
    })) as {
      threads: Array<{ exists: boolean; thread: { projectId: string; historyOrigin: string; providerInstanceId: string }; records: { messages: Array<{ role: string; text: string }>; providerThreads: Array<{ appThreadId: string; providerInstanceId: string; nativeThreadRef: { nativeId: string; strength: string } }> } }>;
    };
    const imported = inspect.threads[0]!;
    expect(imported.exists).toBe(true);
    expect(imported.thread).toMatchObject({ projectId: first.results[0]!.projectId, historyOrigin: "v1_import", providerInstanceId: "codex-alt" });
    expect(imported.records.messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi" },
    ]);
    expect(imported.records.providerThreads).toContainEqual(expect.objectContaining({
      appThreadId: first.results[0]!.threadId,
      providerInstanceId: "codex-alt",
      nativeThreadRef: expect.objectContaining({ nativeId: thread.sourceSessionId, strength: "strong" }),
    }));

    const ledger = new Database(join(root, "ledger", "ledger.sqlite"));
    try {
      expect(ledger.prepare("SELECT COUNT(*) AS count FROM imports").get()).toMatchObject({ count: 1 });
    } finally { ledger.close(); }

    const divergent = canonicalThread(workspace);
    divergent.turns[0]!.activities = [];
    divergent.turns[0]!.assistant[0]!.text = "Changed history";
    const divergentResult = await importConversations([{ conversation: canonicalConversation(workspace, divergent), resume: true }], paths, { ...options, dryRun: false, resume: true });
    expect(divergentResult.results[0]).toMatchObject({ status: "conflict", warnings: expect.arrayContaining([expect.stringContaining("saved converted-task checkpoint")] ) });
    expect(eventCount(dbPath)).toBe(eventTotal);
  });

  it("preserves Codex terminal states, supported activity, plans, usage, and image bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-v2-rich-history-"));
    const workspace = join(root, "workspace");
    const dbPath = join(root, "userdata", "statev2.sqlite");
    const attachmentsDir = join(root, "userdata", "attachments");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(root, "userdata"), { recursive: true });
    copyFileSync(fixture!, dbPath);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");

    const thread = canonicalThread(workspace);
    const baseTurn = structuredClone(thread.turns[0]!);
    thread.turns = [
      baseTurn,
      { ...structuredClone(baseTurn), id: "turn-interrupted", status: "interrupted", terminalReason: "cancelled", user: { ...baseTurn.user, sourceId: "user-interrupted", attachments: [] }, assistant: baseTurn.assistant.map((message) => ({ ...message, sourceId: "assistant-interrupted" })), activities: [], plans: [] },
      { ...structuredClone(baseTurn), id: "turn-failed", status: "failed", terminalError: "provider failed", user: { ...baseTurn.user, sourceId: "user-failed", attachments: [] }, assistant: baseTurn.assistant.map((message) => ({ ...message, sourceId: "assistant-failed" })), activities: [], plans: [] },
    ];
    thread.turns[0]!.user.attachments.push({ sourceId: "image-1", name: "proof.png", mimeType: "image/png", sizeBytes: 9, data: Buffer.from("png-bytes") });
    thread.turns[0]!.plans.push({ sourceId: "markdown-plan", markdown: "1. Inspect the source\n2. Preserve it", timestamp: "2026-01-01T00:00:02.000Z" });
    thread.turns[0]!.activities = [
      { sourceId: "todo-plan", tone: "info", kind: "turn.plan.updated", summary: "Plan updated", timestamp: "2026-01-01T00:00:03.000Z", payload: { plan: [{ step: "Inspect", status: "completed" }, { step: "Write", status: "inProgress" }], explanation: "Work plan" } },
      { sourceId: "tool-run", tone: "tool", kind: "tool.completed", summary: "shell", timestamp: "2026-01-01T00:00:04.000Z", payload: { itemType: "command_execution", status: "completed", data: { item: { name: "shell", input: "pwd", output: "/workspace" } } } },
      { sourceId: "reasoning-summary", tone: "info", kind: "reasoning.summary", summary: "Reasoning", timestamp: "2026-01-01T00:00:05.000Z", payload: { detail: "Checked the workspace." } },
      { sourceId: "compact", tone: "info", kind: "context-compaction", summary: "Context compacted", timestamp: "2026-01-01T00:00:06.000Z", payload: { state: "compacted" } },
      { sourceId: "usage", tone: "info", kind: "context-window.updated", summary: "Usage", timestamp: "2026-01-01T00:00:07.000Z", payload: { usedTokens: 1234, maxTokens: 8192 } },
      { sourceId: "provider-error", tone: "error", kind: "provider.error", summary: "Provider error", timestamp: "2026-01-01T00:00:08.000Z", payload: { detail: "temporary provider failure" } },
    ];
    thread.turns[2]!.activities.push({ sourceId: "failed-turn-error", tone: "error", kind: "provider.error", summary: "Provider error", timestamp: "2026-01-01T00:00:09.000Z", payload: { detail: "provider failed" } });
    const paths = resolveTargetPaths({ dbPath });
    const result = await importConversations([{ conversation: canonicalConversation(workspace, thread), resume: true }], paths, { dryRun: false, resume: true });
    expect(result.results[0]).toMatchObject({ status: "imported", turns: 3, attachments: 1 });

    const inspect = JSON.parse(execFileSync(process.execPath, [helper], {
      input: JSON.stringify({ op: "inspect", dbPath, threadIds: [result.results[0]!.threadId], projectIds: [result.results[0]!.projectId] }),
      encoding: "utf8",
    })) as { threads: Array<{ records: { messages: Array<{ role: string; attachments: Array<{ id: string }> }>; turnItems: Array<{ type: string; status: string; text?: string; markdown?: string; message?: string }>; plans: Array<{ markdown?: string }> } }> };
    const imported = inspect.threads[0]!.records;
    expect(imported.messages[0]!.attachments).toHaveLength(1);
    expect(imported.turnItems.map((item) => item.status)).toContain("interrupted");
    expect(imported.turnItems.map((item) => item.status)).toContain("failed");
    expect(imported.turnItems.map((item) => item.type)).toEqual(expect.arrayContaining([
      "command_execution", "reasoning", "compaction", "error", "todo_list", "proposed_plan", "system_notice",
    ]));
    expect(imported.plans.map((plan) => plan.markdown)).toContain("1. Inspect the source\n2. Preserve it");
    const usage = imported.turnItems.find((item) => item.type === "system_notice");
    expect(usage?.message).toContain("usedTokens=1234");
    expect(readFileSync(join(attachmentsDir, `${imported.messages[0]!.attachments[0]!.id}.png`))).toEqual(Buffer.from("png-bytes"));

    const importedAttachmentPath = join(attachmentsDir, `${imported.messages[0]!.attachments[0]!.id}.png`);
    const persistedEvents = eventCount(dbPath);
    rmSync(importedAttachmentPath);
    const retry = await importConversations([{ conversation: canonicalConversation(workspace, thread), resume: true }], paths, { dryRun: false, resume: true });
    expect(retry.status).toBe("already-imported");
    expect(eventCount(dbPath)).toBe(persistedEvents);
    expect(readFileSync(importedAttachmentPath)).toEqual(Buffer.from("png-bytes"));
    const changedBytes = Buffer.from("changed!");
    writeFileSync(importedAttachmentPath, changedBytes);
    await expect(importConversations([{ conversation: canonicalConversation(workspace, thread), resume: true }], paths, { dryRun: false, resume: true }))
      .rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining("does not match the source session") });
    expect(readFileSync(importedAttachmentPath)).toEqual(changedBytes);
  });

  it("cleans staged images after a native write rejection and preserves preexisting attachment bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-v2-asset-rollback-"));
    const workspace = join(root, "workspace");
    const dbPath = join(root, "userdata", "statev2.sqlite");
    const attachmentsDir = join(root, "userdata", "attachments");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(root, "userdata"), { recursive: true });
    copyFileSync(fixture!, dbPath);
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");

    const thread = canonicalThread(workspace);
    const threadId = thread.sourceSessionId;
    const existingId = `${threadId}-${deterministicUuid(`t3-import:attachment:${threadId}:existing-image`)}`;
    const newId = `${threadId}-${deterministicUuid(`t3-import:attachment:${threadId}:new-image`)}`;
    mkdirSync(attachmentsDir, { recursive: true });
    const preservedBytes = Buffer.from("already-present attachment");
    writeFileSync(join(attachmentsDir, `${existingId}.png`), preservedBytes);
    thread.turns[0]!.user.attachments.push(
      { sourceId: "existing-image", name: "existing.png", mimeType: "image/png", sizeBytes: preservedBytes.length, data: preservedBytes },
      { sourceId: "new-image", name: "new.png", mimeType: "image/png", sizeBytes: 9, data: Buffer.from("new-bytes") },
    );
    thread.turns[0]!.assistant[0]!.timestamp = "not-an-iso-time";
    const paths = resolveTargetPaths({ dbPath });
    const before = eventCount(dbPath);

    await expect(importConversations([{ conversation: canonicalConversation(workspace, thread), resume: true }], paths, { dryRun: false, resume: true }))
      .rejects.toMatchObject({ exitCode: 6, message: expect.stringContaining("verified backup") });
    expect(eventCount(dbPath)).toBeGreaterThanOrEqual(before);
    expect(readFileSync(join(attachmentsDir, `${existingId}.png`))).toEqual(preservedBytes);
    expect(existsSync(join(attachmentsDir, `${newId}.png`))).toBe(false);

    const inspect = JSON.parse(execFileSync(process.execPath, [helper], {
      input: JSON.stringify({ op: "inspect", dbPath, threadIds: [threadId], projectIds: [] }),
      encoding: "utf8",
    })) as { threads: Array<{ exists: boolean; events: Array<{ id: string }> }> };
    expect(inspect.threads[0]!.exists).toBe(false);
    expect(inspect.threads[0]!.events).toEqual([]);
  });
});
