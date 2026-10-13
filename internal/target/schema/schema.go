// Package schema validates the small set of T3 database profiles supported by
// the importer. Validation is deliberately read-only: the importer never runs
// T3-owned migrations.
package schema

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/runinit/t3-syncaroo/internal/target/sqlite"
)

type Profile string

const (
	ProfileLegacy Profile = "legacy"
	ProfileV2     Profile = "nightly-v2"
)

var supportedMigrations = map[int]struct{}{
	40: {}, 41: {}, 42: {}, 43: {}, 44: {}, 45: {}, 46: {},
	47: {}, 48: {}, 49: {}, 50: {}, 51: {}, 52: {}, 53: {},
}

type Info struct {
	Profile     Profile `json:"profile"`
	Migration   int     `json:"migration"`
	Integrity   string  `json:"integrity"`
	EventCount  int64   `json:"eventCount"`
	MaxSequence int64   `json:"maxSequence"`
}

var requiredColumns = map[string][]string{
	"orchestration_events":     {"sequence", "event_id", "aggregate_kind", "stream_id", "stream_version", "event_type", "occurred_at", "actor_kind", "payload_json", "metadata_json"},
	"projection_projects":      {"project_id", "workspace_root", "deleted_at"},
	"projection_state":         {"projector", "last_applied_sequence"},
	"provider_session_runtime": {"thread_id", "provider_name", "provider_instance_id", "adapter_key", "runtime_mode", "status", "last_seen_at", "resume_cursor_json", "runtime_payload_json"},
	"effect_sql_migrations":    {"migration_id", "name", "created_at"},
}

var v2RequiredColumns = map[string][]string{
	"effect_sql_migrations":                         {"migration_id", "name", "created_at"},
	"orchestration_events":                          {"sequence", "event_id", "aggregate_kind", "stream_id", "stream_version", "event_type", "occurred_at", "command_id", "causation_event_id", "correlation_id", "actor_kind", "payload_json", "metadata_json", "application_event_version"},
	"orchestration_v2_projection_metadata":          {"projection_name", "schema_version", "last_sequence", "updated_at"},
	"projection_projects":                           {"project_id", "workspace_root", "deleted_at"},
	"orchestration_v2_projection_threads":           {"thread_id", "project_id", "title", "default_provider", "runtime_mode", "interaction_mode", "active_provider_thread_id", "created_at", "updated_at", "archived_at", "deleted_at", "payload_json", "provider_instance_id"},
	"orchestration_v2_projection_messages":          {"message_id", "thread_id", "run_id", "node_id", "role", "streaming", "created_at", "updated_at", "payload_json"},
	"orchestration_v2_projection_turn_items":        {"turn_item_id", "thread_id", "run_id", "node_id", "provider_thread_id", "provider_turn_id", "parent_item_id", "ordinal", "type", "status", "updated_at", "payload_json"},
	"orchestration_v2_turn_item_positions":          {"thread_id", "turn_item_id", "ordinal"},
	"orchestration_v2_projection_provider_threads":  {"provider_thread_id", "thread_id", "owner_node_id", "provider", "provider_session_id", "status", "first_run_ordinal", "last_run_ordinal", "updated_at", "payload_json", "driver", "provider_instance_id"},
	"orchestration_v2_projection_provider_sessions": {"provider_session_id", "thread_id", "provider", "status", "model", "updated_at", "payload_json", "driver", "provider_instance_id"},
	"provider_session_runtime":                      {"thread_id", "provider_name", "provider_instance_id", "adapter_key", "runtime_mode", "status", "last_seen_at", "resume_cursor_json", "runtime_payload_json"},
}

// Validate checks SQLite integrity, required T3 columns, migration identity,
// and the v2 projection cursor before allowing an operation to proceed.
func Validate(ctx context.Context, db *sql.DB) (Info, error) {
	if db == nil {
		return Info{}, fmt.Errorf("target schema: database is required")
	}
	if err := sqlite.IntegrityCheck(ctx, db); err != nil {
		return Info{}, fmt.Errorf("T3 database integrity check failed: %w", err)
	}
	var tableNames []string
	rows, err := db.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type='table'`)
	if err != nil {
		return Info{}, fmt.Errorf("target schema: list tables: %w", err)
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			_ = rows.Close()
			return Info{}, fmt.Errorf("target schema: read table list: %w", err)
		}
		tableNames = append(tableNames, name)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return Info{}, fmt.Errorf("target schema: read table list: %w", err)
	}
	_ = rows.Close()
	tables := make(map[string]struct{}, len(tableNames))
	for _, name := range tableNames {
		tables[name] = struct{}{}
	}
	if _, ok := tables["effect_sql_migrations"]; !ok {
		return Info{}, fmt.Errorf("not a compatible T3 database: missing table 'effect_sql_migrations'")
	}
	migration, err := currentMigration(ctx, db)
	if err != nil {
		return Info{}, err
	}
	if migration == 61 {
		if err := validateColumns(ctx, db, tables, v2RequiredColumns); err != nil {
			return Info{}, err
		}
		if err := validateV2Signature(ctx, db); err != nil {
			return Info{}, err
		}
		var count, maxSequence int64
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(MAX(sequence),0) FROM orchestration_events`).Scan(&count, &maxSequence); err != nil {
			return Info{}, fmt.Errorf("target schema: read v2 event store: %w", err)
		}
		return Info{Profile: ProfileV2, Migration: migration, Integrity: "ok", EventCount: count, MaxSequence: maxSequence}, nil
	}
	if err := validateColumns(ctx, db, tables, requiredColumns); err != nil {
		return Info{}, err
	}
	if _, ok := supportedMigrations[migration]; !ok {
		return Info{}, fmt.Errorf("unsupported T3 schema migration %d; supported migrations are 40–53", migration)
	}
	var count, maxSequence int64
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(MAX(sequence),0) FROM orchestration_events`).Scan(&count, &maxSequence); err != nil {
		return Info{}, fmt.Errorf("target schema: read event store: %w", err)
	}
	return Info{Profile: ProfileLegacy, Migration: migration, Integrity: "ok", EventCount: count, MaxSequence: maxSequence}, nil
}

func currentMigration(ctx context.Context, db *sql.DB) (int, error) {
	var migration int
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(MAX(migration_id),0) FROM effect_sql_migrations`).Scan(&migration); err != nil {
		return 0, fmt.Errorf("target schema: read current migration: %w", err)
	}
	return migration, nil
}

func validateColumns(ctx context.Context, db *sql.DB, tables map[string]struct{}, required map[string][]string) error {
	for table, columns := range required {
		if _, ok := tables[table]; !ok {
			return fmt.Errorf("not a compatible T3 database: missing table '%s'", table)
		}
		rows, err := db.QueryContext(ctx, `PRAGMA table_info("`+strings.ReplaceAll(table, `"`, `""`)+`")`)
		if err != nil {
			return fmt.Errorf("target schema: inspect %s columns: %w", table, err)
		}
		available := make(map[string]struct{})
		for rows.Next() {
			var cid int
			var name, kind string
			var notNull, primaryKey int
			var defaultValue any
			if err := rows.Scan(&cid, &name, &kind, &notNull, &defaultValue, &primaryKey); err != nil {
				_ = rows.Close()
				return fmt.Errorf("target schema: inspect %s columns: %w", table, err)
			}
			available[name] = struct{}{}
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return fmt.Errorf("target schema: inspect %s columns: %w", table, err)
		}
		_ = rows.Close()
		for _, column := range columns {
			if _, ok := available[column]; !ok {
				return fmt.Errorf("unsupported T3 schema: %s.%s is missing", table, column)
			}
		}
	}
	return nil
}

func validateV2Signature(ctx context.Context, db *sql.DB) error {
	var migration55, migration61 string
	if err := db.QueryRowContext(ctx, `SELECT name FROM effect_sql_migrations WHERE migration_id=55`).Scan(&migration55); err != nil {
		return fmt.Errorf("unsupported T3 schema profile: expected the pinned migration 55/61 signatures")
	}
	if err := db.QueryRowContext(ctx, `SELECT name FROM effect_sql_migrations WHERE migration_id=61`).Scan(&migration61); err != nil || migration55 != "OrchestrationV2" || migration61 != "PullRequestReviewGuides" {
		return fmt.Errorf("unsupported T3 schema profile: expected the pinned migration 55/61 signatures")
	}
	var version int
	var projected int64
	if err := db.QueryRowContext(ctx, `SELECT schema_version,last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name='thread-projections'`).Scan(&version, &projected); err != nil || (version != 1 && version != 2) {
		return fmt.Errorf("unsupported T3 nightly v2 schema: missing or unsupported thread-projections metadata")
	}
	var latest int64
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(MAX(sequence),0) FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread'`).Scan(&latest); err != nil {
		return fmt.Errorf("target schema: read v2 projection high-water mark: %w", err)
	}
	if projected < latest {
		return fmt.Errorf("T3 v2 thread projections are behind the event store (projection %d, v2 thread events %d); open T3 and let it finish loading before importing", projected, latest)
	}
	return nil
}
