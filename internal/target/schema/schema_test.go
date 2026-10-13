package schema

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CarlosGtrz/t3-import/internal/target/sqlite"
)

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sqlite.Open(filepath.Join(t.TempDir(), "target.sqlite"), sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func createTables(t *testing.T, db *sql.DB, tableColumns map[string][]string) {
	t.Helper()
	for table, columns := range tableColumns {
		defs := make([]string, 0, len(columns))
		for _, column := range columns {
			typeName := "TEXT"
			switch column {
			case "migration_id", "sequence", "application_event_version", "schema_version", "last_sequence":
				typeName = "INTEGER"
			}
			defs = append(defs, fmt.Sprintf("%q %s", column, typeName))
		}
		if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %q (%s)", table, strings.Join(defs, ","))); err != nil {
			t.Fatalf("create %s: %v", table, err)
		}
	}
}

func TestValidateLegacyAndRejectsUnknownMigration(t *testing.T) {
	db := testDB(t)
	createTables(t, db, requiredColumns)
	if _, err := db.Exec(`INSERT INTO effect_sql_migrations(migration_id,name,created_at) VALUES (53,'latest','now')`); err != nil {
		t.Fatal(err)
	}
	info, err := Validate(context.Background(), db)
	if err != nil {
		t.Fatalf("validate supported legacy schema: %v", err)
	}
	if info.Profile != ProfileLegacy || info.Migration != 53 || info.Integrity != "ok" {
		t.Fatalf("unexpected schema info: %+v", info)
	}
	if _, err := db.Exec(`INSERT INTO effect_sql_migrations(migration_id,name,created_at) VALUES (54,'future','now')`); err != nil {
		t.Fatal(err)
	}
	if _, err := Validate(context.Background(), db); err == nil || !strings.Contains(err.Error(), "unsupported T3 schema migration 54") {
		t.Fatalf("unknown migration error = %v", err)
	}
}

func TestValidatePinnedV2SignatureAndProjectionCursor(t *testing.T) {
	db := testDB(t)
	all := make(map[string][]string)
	for table, columns := range requiredColumns {
		all[table] = append(all[table], columns...)
	}
	for table, columns := range v2RequiredColumns {
		all[table] = append(all[table], columns...)
	}
	for table, columns := range all {
		seen := map[string]bool{}
		unique := columns[:0]
		for _, column := range columns {
			if !seen[column] {
				seen[column] = true
				unique = append(unique, column)
			}
		}
		all[table] = unique
	}
	createTables(t, db, all)
	if _, err := db.Exec(`INSERT INTO effect_sql_migrations(migration_id,name,created_at) VALUES (55,'OrchestrationV2','now'),(61,'PullRequestReviewGuides','now')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO orchestration_v2_projection_metadata(projection_name,schema_version,last_sequence,updated_at) VALUES ('thread-projections',2,1,'now')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO orchestration_events(sequence,application_event_version,aggregate_kind,event_id) VALUES (1,2,'thread','e1')`); err != nil {
		t.Fatal(err)
	}
	info, err := Validate(context.Background(), db)
	if err != nil {
		t.Fatalf("validate pinned v2 schema: %v", err)
	}
	if info.Profile != ProfileV2 || info.Migration != 61 || info.EventCount != 1 || info.MaxSequence != 1 {
		t.Fatalf("unexpected schema info: %+v", info)
	}
	if _, err := db.Exec(`INSERT INTO orchestration_events(sequence,application_event_version,aggregate_kind,event_id) VALUES (2,2,'thread','e2')`); err != nil {
		t.Fatal(err)
	}
	if _, err := Validate(context.Background(), db); err == nil || !strings.Contains(err.Error(), "projections are behind") {
		t.Fatalf("backlogged projection error = %v", err)
	}
}
