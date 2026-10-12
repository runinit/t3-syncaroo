import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalConversation, canonicalThread, eventCount } from "./helpers.js";
import { resolveTargetPaths } from "../src/target/config.js";
import { importConversations } from "../src/target/importer.js";
import { inspectConversationReplacement, replaceConversations } from "../src/target/replace.js";

const fixture = process.env.T3_V2_FIXTURE_DB;
const nativeHelper = fileURLToPath(new URL("../vendor/t3-v2-native-helper.mjs", import.meta.url));
const originalLedgerDir = process.env.T3_IMPORT_DATA_DIR;

afterEach(() => {
  if (originalLedgerDir === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedgerDir;
});

async function setup(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  const dbPath = join(root, "userdata", "statev2.sqlite");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(root, "userdata"), { recursive: true });
  copyFileSync(fixture!, dbPath);
  process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
  const paths = resolveTargetPaths({ dbPath });
  const thread = canonicalThread(workspace);
  thread.turns[0]!.activities = [];
  const conversation = canonicalConversation(workspace, thread);
  const imported = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  return { root, workspace, paths, conversation, oldThreadId: imported.results[0]!.threadId! };
}

describe.skipIf(!fixture || !existsSync(fixture))("pinned T3 nightly v2 replacement", () => {
  it("replaces one owned task atomically and recovers its ledger mapping without replay", async () => {
    const { root, paths, conversation, oldThreadId } = await setup("t3-v2-replace-recovery-");
    conversation.threads[0]!.turns[0]!.assistant[0]!.text = "Updated source answer";
    conversation.fingerprint = "updated-source-fingerprint";
    const preview = await inspectConversationReplacement(conversation, paths);
    expect(preview).toMatchObject({ status: "replaceable", oldThreadId });

    const ledgerPath = join(root, "ledger", "ledger.sqlite");
    const ledger = new Database(ledgerPath);
    ledger.exec("CREATE TRIGGER reject_replacement_ledger BEFORE INSERT ON imports BEGIN SELECT RAISE(ABORT, 'replacement ledger interruption'); END;");
    ledger.close();
    const before = eventCount(paths.dbPath);
    const first = await replaceConversations([{ conversation }], paths, { dryRun: false });
    expect(first.results[0]).toMatchObject({ status: "replaced", oldThreadId });
    expect(first.warnings.join(" ")).toContain("ledger ownership could not be updated");
    const committedEvents = eventCount(paths.dbPath);
    expect(committedEvents).toBeGreaterThan(before);
    const newThreadId = first.results[0]!.newThreadId!;

    const native = JSON.parse(execFileSync(process.execPath, [nativeHelper], {
      input: JSON.stringify({ op: "inspect", dbPath: paths.dbPath, threadIds: [oldThreadId, newThreadId] }), encoding: "utf8",
    })) as { threads: Array<{ threadId: string; exists: boolean; thread?: { projectId: string; deletedAt?: string | null }; events: Array<{ type: string }> }> };
    expect(native.threads.find((entry) => entry.threadId === oldThreadId)).toMatchObject({ exists: false });
    expect(native.threads.find((entry) => entry.threadId === newThreadId)?.thread?.projectId).toBe(first.results[0]!.projectId);

    const writableLedger = new Database(ledgerPath);
    writableLedger.exec("DROP TRIGGER reject_replacement_ledger;");
    writableLedger.close();
    const retry = await replaceConversations([{ conversation }], paths, { dryRun: false });
    expect(retry).toMatchObject({ status: "already-current", backup: null });
    expect(eventCount(paths.dbPath)).toBe(committedEvents);
    const recovered = new Database(ledgerPath, { readonly: true });
    expect(recovered.prepare("SELECT thread_id threadId, is_canonical canonical FROM imports ORDER BY imported_at DESC LIMIT 1").get())
      .toEqual({ threadId: newThreadId, canonical: 1 });
    recovered.close();
  });

  it("keeps the native event stream unchanged when replacement asset staging fails", async () => {
    const { root, paths, conversation } = await setup("t3-v2-replace-assets-");
    conversation.threads[0]!.turns[0]!.user.attachments.push({
      sourceId: "missing-v2-replacement-image", name: "missing.png", mimeType: "image/png", sizeBytes: 12,
      path: join(root, "missing.png"),
    });
    const before = eventCount(paths.dbPath);
    await expect(replaceConversations([{ conversation }], paths, { dryRun: false })).rejects.toMatchObject({ exitCode: 6 });
    expect(eventCount(paths.dbPath)).toBe(before);
    expect(readdirSync(join(root, "userdata", "attachments"))).toEqual([]);
  });
});
