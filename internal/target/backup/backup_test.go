package backup

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/runinit/t3-syncaroo/internal/target/sqlite"
)

func TestCreateMakesVerifiedTargetSnapshot(t *testing.T) {
	dir := t.TempDir()
	db, err := sqlite.Open(filepath.Join(dir, "state.sqlite"), sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE saved(value TEXT); INSERT INTO saved VALUES ('before')`); err != nil {
		t.Fatal(err)
	}
	path, err := Create(context.Background(), db, dir)
	if err != nil {
		t.Fatal(err)
	}
	copy, err := sqlite.Open(path, sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer copy.Close()
	var value string
	if err := copy.QueryRow(`SELECT value FROM saved`).Scan(&value); err != nil || value != "before" {
		t.Fatalf("backup value = %q, %v", value, err)
	}
}
