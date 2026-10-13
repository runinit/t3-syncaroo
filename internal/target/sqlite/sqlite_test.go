package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func openTestDB(t *testing.T, path string, timeout time.Duration) *sql.DB {
	t.Helper()
	db, err := Open(path, Options{BusyTimeout: timeout})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestBackupRestoreAndIntegrity(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	sourcePath := filepath.Join(dir, "source.db")
	backupPath := filepath.Join(dir, "backup with spaces.db")
	restorePath := filepath.Join(dir, "restore.db")
	source := openTestDB(t, sourcePath, 0)
	if _, err := source.Exec(`CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO entries(value) VALUES ('from source')`); err != nil {
		t.Fatal(err)
	}
	if err := IntegrityCheck(ctx, source); err != nil {
		t.Fatalf("source integrity: %v", err)
	}
	if err := Backup(ctx, source, backupPath); err != nil {
		t.Fatalf("backup: %v", err)
	}
	backup := openTestDB(t, backupPath, 0)
	var value string
	if err := backup.QueryRow(`SELECT value FROM entries WHERE id=1`).Scan(&value); err != nil || value != "from source" {
		t.Fatalf("backup read = %q, %v", value, err)
	}
	restored := openTestDB(t, restorePath, 0)
	if _, err := restored.Exec(`CREATE TABLE old_data (value TEXT); INSERT INTO old_data VALUES ('discard me')`); err != nil {
		t.Fatal(err)
	}
	if err := Restore(ctx, restored, backupPath); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if err := restored.QueryRow(`SELECT value FROM entries WHERE id=1`).Scan(&value); err != nil || value != "from source" {
		t.Fatalf("restored read = %q, %v", value, err)
	}
	if err := IntegrityCheck(ctx, restored); err != nil {
		t.Fatalf("restored integrity: %v", err)
	}
	if _, err := restored.Exec(`SELECT value FROM old_data`); err == nil {
		t.Fatal("restore did not replace prior destination contents")
	}
}

func TestWithTransactionCommitsAndRollsBack(t *testing.T) {
	db := openTestDB(t, filepath.Join(t.TempDir(), "transactions.db"), 0)
	if _, err := db.Exec(`CREATE TABLE values_table (value TEXT)`); err != nil {
		t.Fatal(err)
	}
	if err := WithTransaction(context.Background(), db, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO values_table VALUES ('committed')`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	wantErr := errors.New("stop")
	if err := WithTransaction(context.Background(), db, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO values_table VALUES ('rolled back')`)
		if err != nil {
			return err
		}
		return wantErr
	}); !errors.Is(err, wantErr) {
		t.Fatalf("transaction error = %v, want wrapped sentinel", err)
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM values_table`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("row count = %d, %v", n, err)
	}
}

func TestOpenBoundsBusyTimeoutAndLockWait(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "locked.db")
	first := openTestDB(t, path, 0)
	if _, err := first.Exec(`CREATE TABLE items (value INTEGER)`); err != nil {
		t.Fatal(err)
	}
	if _, err := first.Exec(`BEGIN IMMEDIATE`); err != nil {
		t.Fatal(err)
	}
	defer first.Exec(`ROLLBACK`)
	second := openTestDB(t, path, 40*time.Millisecond)
	started := time.Now()
	_, err := second.Exec(`INSERT INTO items VALUES (1)`)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "locked") {
		t.Fatalf("competing write error = %v, want locked/busy", err)
	}
	if elapsed := time.Since(started); elapsed < 25*time.Millisecond || elapsed > time.Second {
		t.Fatalf("bounded lock wait took %s", elapsed)
	}
	if _, err := Open(filepath.Join(dir, "invalid.db"), Options{BusyTimeout: maxBusyTimeout + 1}); err == nil {
		t.Fatal("expected oversized timeout to be rejected")
	}
}

func TestBackupHonorsCancellation(t *testing.T) {
	db := openTestDB(t, filepath.Join(t.TempDir(), "cancel-source.db"), 0)
	if _, err := db.Exec(`CREATE TABLE items(value TEXT)`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := Backup(ctx, db, filepath.Join(t.TempDir(), "cancel-backup.db"))
	if err == nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("backup cancellation error = %v", err)
	}
}

func TestOpenRejectsInvalidPaths(t *testing.T) {
	if _, err := Open("", Options{}); err == nil {
		t.Fatal("expected empty path to fail")
	}
	db, err := Open(filepath.Join(t.TempDir(), "not", "present", "db.sqlite"), Options{})
	if err != nil {
		t.Fatalf("sql.Open should remain lazy: %v", err)
	}
	defer db.Close()
	if err := db.Ping(); err == nil {
		t.Fatal("expected missing parent directory to fail on connection")
	}
}

func TestOpenReadOnlyAllowsQueriesAndRejectsWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "readonly.db")
	writable := openTestDB(t, path, 0)
	if _, err := writable.Exec(`CREATE TABLE entries (value TEXT); INSERT INTO entries VALUES ('existing')`); err != nil {
		t.Fatal(err)
	}
	if err := writable.Close(); err != nil {
		t.Fatal(err)
	}

	db, err := Open(path, Options{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var value string
	if err := db.QueryRow(`SELECT value FROM entries`).Scan(&value); err != nil || value != "existing" {
		t.Fatalf("readonly query = %q, %v", value, err)
	}
	if _, err := db.Exec(`INSERT INTO entries VALUES ('should fail')`); err == nil {
		t.Fatal("readonly database accepted a write")
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM entries`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("row count after refused write = %d, %v", count, err)
	}
}
