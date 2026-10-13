package legacy

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/CarlosGtrz/t3-import/internal/checkpoint"
	"github.com/CarlosGtrz/t3-import/internal/domain"
	"github.com/CarlosGtrz/t3-import/internal/target/schema"
	"github.com/CarlosGtrz/t3-import/internal/target/sqlite"
)

//go:embed testdata/t3-schemas.json
var historicalSchemas embed.FS

type historicalSchema struct {
	Commit     string   `json:"commit"`
	DDL        []string `json:"ddl"`
	Migrations []struct {
		ID        int    `json:"migration_id"`
		Name      string `json:"name"`
		CreatedAt string `json:"created_at"`
	} `json:"migrations"`
}

type schemaObject struct {
	Type string
	Name string
	SQL  string
}

func TestLegacyOperationsAgainstHistoricalT3Schemas(t *testing.T) {
	fixture, err := historicalSchemas.ReadFile("testdata/t3-schemas.json")
	if err != nil {
		t.Fatal(err)
	}
	var snapshots map[string]historicalSchema
	if err := json.Unmarshal(fixture, &snapshots); err != nil {
		t.Fatal(err)
	}
	for migration := 40; migration <= 53; migration++ {
		migration := migration
		t.Run(fmt.Sprintf("migration_%d", migration), func(t *testing.T) {
			snapshot, ok := snapshots[fmt.Sprint(migration)]
			if !ok || snapshot.Commit == "" || len(snapshot.DDL) == 0 || len(snapshot.Migrations) == 0 {
				t.Fatalf("historical T3 schema fixture for migration %d is incomplete", migration)
			}
			db, err := sqlite.Open(filepath.Join(t.TempDir(), "state.sqlite"), sqlite.Options{})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = db.Close() })
			ctx := context.Background()
			for _, statement := range snapshot.DDL {
				if _, err := db.ExecContext(ctx, statement); err != nil {
					t.Fatalf("apply T3 %s DDL: %v", snapshot.Commit, err)
				}
			}
			for _, row := range snapshot.Migrations {
				if _, err := db.ExecContext(ctx, `INSERT INTO effect_sql_migrations(migration_id,name,created_at) VALUES(?,?,?)`, row.ID, row.Name, row.CreatedAt); err != nil {
					t.Fatalf("insert migration %d record: %v", row.ID, err)
				}
			}

			info, err := schema.Validate(ctx, db)
			if err != nil || info.Profile != schema.ProfileLegacy || info.Migration != migration {
				t.Fatalf("validate T3 %d schema: info=%+v err=%v", migration, info, err)
			}
			objectsBefore := readSchemaObjects(t, db)
			migrationsBefore := readMigrationRows(t, db)

			thread := sample()
			thread.Source = domain.SourceClaude
			thread.SourceSessionID = "claude-session"
			thread.SourceKey = "claude:claude-session"
			thread.ResumeCursor = map[string]any{"resume": "source-session"}
			target := Target{ThreadID: "thread-" + fmt.Sprint(migration), ProjectID: "project", IdentitySeed: thread.SourceKey, Workspace: "/fixture/workspace", CreateProject: true, Migration: migration}
			provider := Provider{ProviderName: "claudeAgent", InstanceID: "claude-fixture", AdapterKey: "claudeAgent", Model: "test-model"}
			plan := PlanImport(thread, target, provider, true)
			first, last, err := Import(ctx, db, plan)
			if err != nil || first == 0 || last < first {
				t.Fatalf("import on T3 %d schema: range=%d..%d err=%v", migration, first, last, err)
			}
			preview, err := PreviewImport(ctx, db, target, thread)
			if err != nil || !preview.AlreadyImported || preview.Migration != migration {
				t.Fatalf("repeat import preview: preview=%+v err=%v", preview, err)
			}

			checkpointBeforeSync, err := checkpoint.ForThread(thread)
			if err != nil {
				t.Fatal(err)
			}
			next := canonicalTurnForCompatibility("turn-2", "next question", "next answer")
			continued := thread
			continued.Turns = append(append([]domain.CanonicalTurn(nil), thread.Turns...), next)
			continued.UpdatedAt = *next.CompletedAt
			synced, err := SyncAppend(ctx, db, continued, target, provider, checkpointBeforeSync, last, true)
			if err != nil || !synced.Appended || synced.TurnsAdded != 1 {
				t.Fatalf("sync on T3 %d schema: result=%+v err=%v", migration, synced, err)
			}
			adopted, err := SyncAppend(ctx, db, continued, target, provider, checkpointBeforeSync, last, true)
			if err != nil || adopted.TurnsAdopted != 1 || adopted.TurnsAdded != 0 {
				t.Fatalf("repeat sync adoption: result=%+v err=%v", adopted, err)
			}

			replacement := thread
			replacement.Title = "Replacement task"
			replacement.UpdatedAt = "2026-01-02T00:00:00.000Z"
			replacementTarget := target
			replacementTarget.ThreadID = target.ThreadID + "-replacement"
			replacementTarget.IdentitySeed = thread.SourceKey + ":replacement"
			replacementTarget.CreateProject = false
			replacementPlan := PlanImport(replacement, replacementTarget, provider, true)
			tombstone := evt("compatibility-replacement", "thread.deleted", "thread", target.ThreadID, "thread.deleted", replacement.UpdatedAt, "client", map[string]any{"threadId": target.ThreadID}, nil)
			if _, _, err := Replace(ctx, db, replacementPlan, []Event{tombstone}); err != nil {
				t.Fatalf("replacement on T3 %d schema: %v", migration, err)
			}
			if _, err := schema.Validate(ctx, db); err != nil {
				t.Fatalf("revalidate T3 %d schema after writes: %v", migration, err)
			}
			if objectsAfter := readSchemaObjects(t, db); !reflect.DeepEqual(objectsBefore, objectsAfter) {
				t.Fatalf("importer changed T3 %d schema objects", migration)
			}
			if migrationsAfter := readMigrationRows(t, db); !reflect.DeepEqual(migrationsBefore, migrationsAfter) {
				t.Fatalf("importer changed T3 %d migration records", migration)
			}
		})
	}
}

func canonicalTurnForCompatibility(id, userText, assistantText string) domain.CanonicalTurn {
	completedAt := "2026-01-01T00:00:05.000Z"
	return domain.CanonicalTurn{
		ID: id, StartedAt: "2026-01-01T00:00:03.000Z", CompletedAt: &completedAt, Status: domain.TurnCompleted,
		User:      domain.CanonicalMessage{SourceID: id + ":user", Role: "user", Text: userText, Timestamp: "2026-01-01T00:00:03.000Z"},
		Assistant: []domain.CanonicalMessage{{SourceID: id + ":assistant", Role: "assistant", Text: assistantText, Timestamp: completedAt}},
	}
}

func readSchemaObjects(t *testing.T, db *sql.DB) []schemaObject {
	t.Helper()
	rows, err := db.Query(`SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var objects []schemaObject
	for rows.Next() {
		var object schemaObject
		if err := rows.Scan(&object.Type, &object.Name, &object.SQL); err != nil {
			t.Fatal(err)
		}
		objects = append(objects, object)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	sort.Slice(objects, func(i, j int) bool {
		if objects[i].Type != objects[j].Type {
			return objects[i].Type < objects[j].Type
		}
		return objects[i].Name < objects[j].Name
	})
	return objects
}

func readMigrationRows(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT migration_id,name,created_at FROM effect_sql_migrations ORDER BY migration_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var records []string
	for rows.Next() {
		var id int
		var name, createdAt string
		if err := rows.Scan(&id, &name, &createdAt); err != nil {
			t.Fatal(err)
		}
		records = append(records, fmt.Sprintf("%d\x00%s\x00%s", id, name, createdAt))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return records
}
