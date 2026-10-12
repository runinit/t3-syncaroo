import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listImports, listImportsForTargets } from "../src/target/ledger.js";

let originalLedgerDir: string | undefined;

beforeEach(() => { originalLedgerDir = process.env.T3_IMPORT_DATA_DIR; });
afterEach(() => {
  if (originalLedgerDir === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedgerDir;
});

describe("external ledger migration", () => {
  it("adds checkpoint columns to a 0.1 ledger in place", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3-ledger-v1-"));
    process.env.T3_IMPORT_DATA_DIR = directory;
    mkdirSync(directory, { recursive: true });
    const db = new Database(join(directory, "ledger.sqlite"));
    db.exec(`
      CREATE TABLE imports (
        target_id TEXT NOT NULL, source TEXT NOT NULL, source_session_id TEXT NOT NULL,
        source_key TEXT NOT NULL, source_fingerprint TEXT NOT NULL, project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL, imported_at TEXT NOT NULL, importer_version TEXT NOT NULL,
        migration INTEGER NOT NULL, first_sequence INTEGER NOT NULL, last_sequence INTEGER NOT NULL,
        resumable INTEGER NOT NULL, backup_path TEXT NOT NULL, warnings_json TEXT NOT NULL,
        PRIMARY KEY (target_id, source_key, thread_id)
      );
      INSERT INTO imports VALUES ('target', 'codex', 'session', 'codex:session', 'fingerprint', 'project', 'thread', '2026-01-01T00:00:00.000Z', '0.1.0', 40, 1, 10, 1, 'backup', '[]');
    `);
    db.close();

    const rows = listImports("target", "codex");
    expect(rows[0]).toMatchObject({ identitySeed: "codex:session", currentSourceKey: "codex:session", sourceTitle: "" });
    const migrated = new Database(join(directory, "ledger.sqlite"), { readonly: true });
    const columns = (migrated.prepare("PRAGMA table_info(imports)").all() as Array<{ name: string }>).map((row) => row.name);
    migrated.close();
    expect(columns).toEqual(expect.arrayContaining(["identity_seed", "checkpoint_json", "source_title", "synced_at", "is_canonical", "superseded_by_thread_id", "replaced_at"]));
  });

  it("lists mappings for a deduplicated set of known target IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3-ledger-targets-"));
    process.env.T3_IMPORT_DATA_DIR = directory;
    const db = new Database(join(directory, "ledger.sqlite"));
    db.exec(`CREATE TABLE imports (
      target_id TEXT NOT NULL, source TEXT NOT NULL, source_session_id TEXT NOT NULL,
      source_key TEXT NOT NULL, source_fingerprint TEXT NOT NULL, project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, imported_at TEXT NOT NULL, importer_version TEXT NOT NULL,
      migration INTEGER NOT NULL, first_sequence INTEGER NOT NULL, last_sequence INTEGER NOT NULL,
      resumable INTEGER NOT NULL, backup_path TEXT NOT NULL, warnings_json TEXT NOT NULL,
      PRIMARY KEY (target_id, source_key, thread_id)
    );
    INSERT INTO imports VALUES
      ('old-target', 'codex', 'session-a', 'codex:a', 'fingerprint-a', 'project', 'thread-a', '2026-01-01T00:00:00.000Z', '0.1.0', 53, 1, 2, 1, 'backup', '[]'),
      ('new-target', 'claude', 'session-b', 'claude:b', 'fingerprint-b', 'project', 'thread-b', '2026-01-02T00:00:00.000Z', '0.1.0', 53, 3, 4, 1, 'backup', '[]');`);
    db.close();

    expect(listImportsForTargets(["old-target", "new-target", "old-target"], "codex")).toMatchObject([
      { targetId: "old-target", source: "codex", threadId: "thread-a" },
    ]);
    expect(listImportsForTargets(["", ""])).toEqual([]);
  });
});
