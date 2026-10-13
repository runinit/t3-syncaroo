package ledger

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/runinit/t3-syncaroo/internal/domain"
	"github.com/runinit/t3-syncaroo/internal/target/sqlite"
)

func testRecord(key, thread string) Record {
	canonical := true
	return Record{
		TargetID: "target", Source: domain.SourceCodex, SourceSessionID: "session",
		SourceKey: key, SourceFingerprint: "fingerprint", ProjectID: "project", ThreadID: thread,
		ImporterVersion: "1.0.0", Migration: 53, FirstSequence: 1, LastSequence: 9,
		Resumable: true, BackupPath: "/backup/state.sqlite", Warnings: []string{"warning"},
		SourceTitle: "Example", Checkpoint: json.RawMessage(`{"version":2,"turns":[{"id":"turn","status":"completed","hash":"abc"}]}`),
		IsCanonical: &canonical,
	}
}

func TestStoreRoundTripsAndConsolidatesRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.sqlite")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.RecordImports(context.Background(), []Record{testRecord("source-a", "thread-a")}); err != nil {
		t.Fatal(err)
	}
	rows, err := store.List(context.Background(), "target", domain.SourceCodex)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].ThreadID != "thread-a" || rows[0].IdentitySeed != "source-a" || rows[0].CurrentSourceKey != "source-a" || rows[0].IsCanonical == nil || !*rows[0].IsCanonical {
		t.Fatalf("unexpected round trip: %+v", rows)
	}
	if err := store.RecordConsolidation(context.Background(), rows, testRecord("source-b", "thread-b")); err != nil {
		t.Fatal(err)
	}
	rows, err = store.ListForTargets(context.Background(), []string{"target", "target", ""}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("consolidated rows = %d, want old + new", len(rows))
	}
	var old, current *Record
	for i := range rows {
		if rows[i].ThreadID == "thread-a" {
			old = &rows[i]
		}
		if rows[i].ThreadID == "thread-b" {
			current = &rows[i]
		}
	}
	if old == nil || old.IsCanonical == nil || *old.IsCanonical || old.SupersededByThreadID == nil || *old.SupersededByThreadID != "thread-b" {
		t.Fatalf("old mapping not superseded: %+v", old)
	}
	if current == nil || current.IsCanonical == nil || !*current.IsCanonical {
		t.Fatalf("new mapping not canonical: %+v", current)
	}
}

func TestRecordConsolidationsRollsBackWholeBatchOnInvalidReplacement(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "ledger.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()
	old := testRecord("source-a", "thread-a")
	if err := store.RecordImports(ctx, []Record{old}); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordConsolidations(ctx, []Consolidation{
		{OldRecords: []Record{old}, NewRecord: testRecord("source-a", "thread-b")},
		{OldRecords: []Record{testRecord("source-c", "thread-c")}, NewRecord: Record{}},
	}); err == nil {
		t.Fatal("invalid batch replacement unexpectedly committed")
	}
	rows, err := store.List(ctx, "target", domain.SourceCodex)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].ThreadID != "thread-a" || rows[0].IsCanonical == nil || !*rows[0].IsCanonical || rows[0].SupersededByThreadID != nil {
		t.Fatalf("failed batch changed ledger records: %+v", rows)
	}
}

func TestStoreMigratesExistingLedgerColumns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.sqlite")
	db, err := sqlite.Open(path, sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE imports (
		target_id TEXT NOT NULL, source TEXT NOT NULL, source_session_id TEXT NOT NULL,
		source_key TEXT NOT NULL, source_fingerprint TEXT NOT NULL, project_id TEXT NOT NULL,
		thread_id TEXT NOT NULL, imported_at TEXT NOT NULL, importer_version TEXT NOT NULL,
		migration INTEGER NOT NULL, first_sequence INTEGER NOT NULL, last_sequence INTEGER NOT NULL,
		resumable INTEGER NOT NULL, backup_path TEXT NOT NULL, warnings_json TEXT NOT NULL,
		PRIMARY KEY(target_id,source_key,thread_id))`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO imports VALUES ('target','codex','session','old','fp','project','thread','now','0.1',53,1,2,1,'backup','[]')`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	rows, err := store.List(context.Background(), "target", domain.SourceCodex)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].IdentitySeed != "old" || rows[0].CurrentSourceKey != "old" {
		t.Fatalf("old schema mapping not retained: %+v", rows)
	}
	var columnCount int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('imports') WHERE name='checkpoint_json'`).Scan(&columnCount); err != nil || columnCount != 1 {
		t.Fatalf("checkpoint_json migration = %d, %v", columnCount, err)
	}
}

func TestDefaultPathHonorsDataOverride(t *testing.T) {
	t.Setenv("T3_IMPORT_DATA_DIR", filepath.Join(t.TempDir(), "state"))
	path, err := DefaultPath()
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(path) != "ledger.sqlite" || filepath.Dir(path) != os.Getenv("T3_IMPORT_DATA_DIR") {
		t.Fatalf("unexpected default path: %s", path)
	}
}
