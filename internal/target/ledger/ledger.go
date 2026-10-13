// Package ledger stores importer-owned source-to-T3 mappings outside T3's
// database. Its SQLite schema matches the established t3-import ledger.
package ledger

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/runinit/t3-syncaroo/internal/checkpoint"
	"github.com/runinit/t3-syncaroo/internal/domain"
	"github.com/runinit/t3-syncaroo/internal/target/sqlite"
)

type Record struct {
	TargetID                 string
	Source                   domain.SourceName
	SourceSessionID          string
	SourceKey                string
	SourceFingerprint        string
	ProjectID                string
	ThreadID                 string
	ImportedAt               string
	ImporterVersion          string
	Migration                int
	FirstSequence            int64
	LastSequence             int64
	Resumable                bool
	BackupPath               string
	Warnings                 []string
	IdentitySeed             string
	CurrentSourceKey         string
	SourceLeafID             *string
	NativeConversationHeadID *string
	SourceTitle              string
	Checkpoint               json.RawMessage
	SyncedAt                 *string
	IsCanonical              *bool
	SupersededByThreadID     *string
	ReplacedAt               *string
}

type Store struct{ db *sql.DB }

// Consolidation groups prior mappings with the replacement mapping that
// supersedes them. A batch is recorded in one ledger transaction.
type Consolidation struct {
	OldRecords []Record
	NewRecord  Record
}

// DefaultPath follows the existing env-paths "data" location used by the
// TypeScript importer, while allowing the same explicit override.
func DefaultPath() (string, error) {
	if override := strings.TrimSpace(os.Getenv("T3_IMPORT_DATA_DIR")); override != "" {
		return filepath.Join(override, "ledger.sqlite"), nil
	}
	if runtime.GOOS == "windows" {
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			var err error
			base, err = os.UserConfigDir()
			if err != nil {
				return "", err
			}
		}
		return filepath.Join(base, "t3-import", "Data", "ledger.sqlite"), nil
	}
	if runtime.GOOS == "darwin" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Application Support", "t3-import", "ledger.sqlite"), nil
	}
	base := strings.TrimSpace(os.Getenv("XDG_DATA_HOME"))
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "t3-import", "ledger.sqlite"), nil
}

func Open(path string) (*Store, error) {
	if path == "" {
		return nil, fmt.Errorf("ledger: path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("ledger: create data directory: %w", err)
	}
	db, err := sqlite.Open(path, sqlite.Options{})
	if err != nil {
		return nil, fmt.Errorf("ledger: open database: %w", err)
	}
	if _, err := db.Exec(`PRAGMA journal_mode=WAL`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ledger: enable WAL: %w", err)
	}
	store := &Store{db: db}
	if err := store.ensureSchema(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) ensureSchema(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS imports (
		target_id TEXT NOT NULL,
		source TEXT NOT NULL,
		source_session_id TEXT NOT NULL,
		source_key TEXT NOT NULL,
		source_fingerprint TEXT NOT NULL,
		project_id TEXT NOT NULL,
		thread_id TEXT NOT NULL,
		imported_at TEXT NOT NULL,
		importer_version TEXT NOT NULL,
		migration INTEGER NOT NULL,
		first_sequence INTEGER NOT NULL,
		last_sequence INTEGER NOT NULL,
		resumable INTEGER NOT NULL,
		backup_path TEXT NOT NULL,
		warnings_json TEXT NOT NULL,
		PRIMARY KEY (target_id, source_key, thread_id)
	)`)
	if err != nil {
		return fmt.Errorf("ledger: create imports table: %w", err)
	}
	columns, err := tableColumns(ctx, s.db)
	if err != nil {
		return err
	}
	additions := []struct{ name, kind string }{
		{"identity_seed", "TEXT"}, {"current_source_key", "TEXT"}, {"source_leaf_id", "TEXT"},
		{"native_conversation_head_id", "TEXT"}, {"source_title", "TEXT"},
		{"checkpoint_version", "INTEGER"}, {"checkpoint_json", "TEXT"}, {"synced_at", "TEXT"},
		{"is_canonical", "INTEGER"}, {"superseded_by_thread_id", "TEXT"}, {"replaced_at", "TEXT"},
	}
	for _, addition := range additions {
		if columns[addition.name] {
			continue
		}
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE imports ADD COLUMN `+addition.name+` `+addition.kind); err != nil {
			return fmt.Errorf("ledger: add %s column: %w", addition.name, err)
		}
	}
	return nil
}

func tableColumns(ctx context.Context, db *sql.DB) (map[string]bool, error) {
	rows, err := db.QueryContext(ctx, `PRAGMA table_info(imports)`)
	if err != nil {
		return nil, fmt.Errorf("ledger: inspect imports table: %w", err)
	}
	defer rows.Close()
	columns := map[string]bool{}
	for rows.Next() {
		var cid, notNull, primary int
		var name, kind string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &kind, &notNull, &defaultValue, &primary); err != nil {
			return nil, fmt.Errorf("ledger: read imports columns: %w", err)
		}
		columns[name] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ledger: read imports columns: %w", err)
	}
	return columns, nil
}

func (s *Store) List(ctx context.Context, targetID string, source domain.SourceName) ([]Record, error) {
	query := `SELECT target_id,source,source_session_id,source_key,source_fingerprint,project_id,thread_id,imported_at,importer_version,migration,first_sequence,last_sequence,resumable,backup_path,warnings_json,identity_seed,current_source_key,source_leaf_id,native_conversation_head_id,source_title,checkpoint_json,synced_at,is_canonical,superseded_by_thread_id,replaced_at FROM imports WHERE target_id=?`
	args := []any{targetID}
	if source != "" {
		query += ` AND source=?`
		args = append(args, source)
	}
	query += ` ORDER BY imported_at DESC`
	return s.query(ctx, query, args...)
}

func (s *Store) ListForTargets(ctx context.Context, targetIDs []string, source domain.SourceName) ([]Record, error) {
	unique := make([]string, 0, len(targetIDs))
	seen := map[string]bool{}
	for _, id := range targetIDs {
		if id != "" && !seen[id] {
			unique = append(unique, id)
			seen[id] = true
		}
	}
	if len(unique) == 0 {
		return []Record{}, nil
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(unique)), ",")
	query := `SELECT target_id,source,source_session_id,source_key,source_fingerprint,project_id,thread_id,imported_at,importer_version,migration,first_sequence,last_sequence,resumable,backup_path,warnings_json,identity_seed,current_source_key,source_leaf_id,native_conversation_head_id,source_title,checkpoint_json,synced_at,is_canonical,superseded_by_thread_id,replaced_at FROM imports WHERE target_id IN (` + placeholders + `)`
	args := make([]any, 0, len(unique)+1)
	for _, id := range unique {
		args = append(args, id)
	}
	if source != "" {
		query += ` AND source=?`
		args = append(args, source)
	}
	query += ` ORDER BY imported_at DESC`
	return s.query(ctx, query, args...)
}

func (s *Store) query(ctx context.Context, query string, args ...any) ([]Record, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("ledger: query records: %w", err)
	}
	defer rows.Close()
	var records []Record
	for rows.Next() {
		var row Record
		var source, warnings string
		var resumable int
		var identity, current, leaf, head, title, rawCheckpoint, synced, superseded, replaced sql.NullString
		var canonical sql.NullInt64
		if err := rows.Scan(&row.TargetID, &source, &row.SourceSessionID, &row.SourceKey, &row.SourceFingerprint, &row.ProjectID, &row.ThreadID, &row.ImportedAt, &row.ImporterVersion, &row.Migration, &row.FirstSequence, &row.LastSequence, &resumable, &row.BackupPath, &warnings, &identity, &current, &leaf, &head, &title, &rawCheckpoint, &synced, &canonical, &superseded, &replaced); err != nil {
			return nil, fmt.Errorf("ledger: read record: %w", err)
		}
		row.Source = domain.SourceName(source)
		row.Resumable = resumable == 1
		_ = json.Unmarshal([]byte(warnings), &row.Warnings)
		if row.Warnings == nil {
			row.Warnings = []string{}
		}
		row.IdentitySeed = identity.String
		if row.IdentitySeed == "" {
			row.IdentitySeed = row.SourceKey
		}
		row.CurrentSourceKey = current.String
		if row.CurrentSourceKey == "" {
			row.CurrentSourceKey = row.SourceKey
		}
		row.SourceLeafID = nullableString(leaf)
		row.NativeConversationHeadID = nullableString(head)
		row.SourceTitle = title.String
		if rawCheckpoint.Valid {
			row.Checkpoint = json.RawMessage(rawCheckpoint.String)
		}
		row.SyncedAt = nullableString(synced)
		if canonical.Valid {
			value := canonical.Int64 == 1
			row.IsCanonical = &value
		}
		row.SupersededByThreadID = nullableString(superseded)
		row.ReplacedAt = nullableString(replaced)
		records = append(records, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ledger: read records: %w", err)
	}
	return records, nil
}

func nullableString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	text := value.String
	return &text
}

func (s *Store) RecordImports(ctx context.Context, records []Record) error {
	if len(records) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("ledger: begin import records: %w", err)
	}
	defer tx.Rollback()
	for _, record := range records {
		if err := insert(ctx, tx, record); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("ledger: commit import records: %w", err)
	}
	return nil
}

func (s *Store) RecordConsolidation(ctx context.Context, oldRecords []Record, newRecord Record) error {
	return s.RecordConsolidations(ctx, []Consolidation{{OldRecords: oldRecords, NewRecord: newRecord}})
}

// RecordConsolidations atomically marks all prior mappings noncanonical and
// records their replacement mappings. Callers use it after all corresponding
// target database writes have succeeded.
func (s *Store) RecordConsolidations(ctx context.Context, updates []Consolidation) error {
	if len(updates) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("ledger: begin consolidations: %w", err)
	}
	defer tx.Rollback()
	for _, update := range updates {
		newRecord := update.NewRecord
		replacedAt := newRecord.ReplacedAt
		if replacedAt == nil {
			value := time.Now().UTC().Format(time.RFC3339Nano)
			replacedAt = &value
		}
		for _, old := range update.OldRecords {
			if _, err := tx.ExecContext(ctx, `UPDATE imports SET is_canonical=0,superseded_by_thread_id=?,replaced_at=? WHERE target_id=? AND thread_id=?`, newRecord.ThreadID, *replacedAt, old.TargetID, old.ThreadID); err != nil {
				return fmt.Errorf("ledger: mark previous mapping superseded: %w", err)
			}
		}
		newRecord.IsCanonical = boolPointer(true)
		newRecord.ReplacedAt = replacedAt
		if err := insert(ctx, tx, newRecord); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("ledger: commit consolidations: %w", err)
	}
	return nil
}

// RecordSyncResults atomically writes ordinary sync records and any recovered
// replacement ownership changes. The latter keeps a crash-recovered thread
// from leaving both its old and replacement mappings canonical.
func (s *Store) RecordSyncResults(ctx context.Context, records []Record, consolidations []Consolidation) error {
	if len(records) == 0 && len(consolidations) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("ledger: begin sync results: %w", err)
	}
	defer tx.Rollback()
	for _, row := range records {
		if err := insert(ctx, tx, row); err != nil {
			return err
		}
	}
	for _, update := range consolidations {
		newRecord := update.NewRecord
		if len(update.OldRecords) > 0 {
			replacedAt := newRecord.ReplacedAt
			if replacedAt == nil {
				value := time.Now().UTC().Format(time.RFC3339Nano)
				replacedAt = &value
			}
			for _, old := range update.OldRecords {
				if _, err := tx.ExecContext(ctx, `UPDATE imports SET is_canonical=0,superseded_by_thread_id=?,replaced_at=? WHERE target_id=? AND thread_id=?`, newRecord.ThreadID, *replacedAt, old.TargetID, old.ThreadID); err != nil {
					return fmt.Errorf("ledger: recover previous mapping: %w", err)
				}
			}
			newRecord.IsCanonical = boolPointer(true)
			newRecord.ReplacedAt = replacedAt
		}
		if err := insert(ctx, tx, newRecord); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("ledger: commit sync results: %w", err)
	}
	return nil
}

func (s *Store) RecordReplacement(ctx context.Context, oldRecord, newRecord Record) error {
	return s.RecordConsolidation(ctx, []Record{oldRecord}, newRecord)
}

type execer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func insert(ctx context.Context, target execer, row Record) error {
	if row.TargetID == "" || row.Source == "" || row.SourceSessionID == "" || row.SourceKey == "" || row.ThreadID == "" {
		return fmt.Errorf("ledger: target, source, session, source key and thread ID are required")
	}
	if row.Checkpoint != nil {
		if _, ok := checkpoint.Parse(string(row.Checkpoint)); !ok {
			return fmt.Errorf("ledger: invalid checkpoint for thread %s", row.ThreadID)
		}
	}
	if row.ImportedAt == "" {
		row.ImportedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if row.IdentitySeed == "" {
		row.IdentitySeed = row.SourceKey
	}
	if row.CurrentSourceKey == "" {
		row.CurrentSourceKey = row.SourceKey
	}
	if row.Warnings == nil {
		row.Warnings = []string{}
	}
	warnings, err := json.Marshal(row.Warnings)
	if err != nil {
		return fmt.Errorf("ledger: encode warnings: %w", err)
	}
	checkpointVersion := 0
	var checkpointJSON any
	if row.Checkpoint != nil {
		parsed, _ := checkpoint.Parse(string(row.Checkpoint))
		checkpointVersion = parsed.Version
		checkpointJSON = string(row.Checkpoint)
	}
	_, err = target.ExecContext(ctx, `INSERT OR REPLACE INTO imports (
		target_id,source,source_session_id,source_key,source_fingerprint,project_id,thread_id,imported_at,importer_version,migration,
		first_sequence,last_sequence,resumable,backup_path,warnings_json,identity_seed,current_source_key,source_leaf_id,native_conversation_head_id,
		source_title,checkpoint_version,checkpoint_json,synced_at,is_canonical,superseded_by_thread_id,replaced_at
	) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		row.TargetID, row.Source, row.SourceSessionID, row.SourceKey, row.SourceFingerprint, row.ProjectID, row.ThreadID, row.ImportedAt, row.ImporterVersion, row.Migration,
		row.FirstSequence, row.LastSequence, boolInt(row.Resumable), row.BackupPath, string(warnings), row.IdentitySeed, row.CurrentSourceKey, row.SourceLeafID, row.NativeConversationHeadID,
		row.SourceTitle, nullableInt(checkpointVersion), checkpointJSON, row.SyncedAt, nullableBool(row.IsCanonical), row.SupersededByThreadID, row.ReplacedAt)
	if err != nil {
		return fmt.Errorf("ledger: record thread %s: %w", row.ThreadID, err)
	}
	return nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
func nullableInt(value int) any {
	if value == 0 {
		return nil
	}
	return value
}
func nullableBool(value *bool) any {
	if value == nil {
		return nil
	}
	return boolInt(*value)
}
func boolPointer(value bool) *bool { return &value }
