// Package sqlite contains the importer-owned boundary around the SQLite driver.
// It deliberately exposes database/sql rather than T3-specific schema helpers.
package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	driver "modernc.org/sqlite"
)

const (
	defaultBusyTimeout = 5 * time.Second
	maxBusyTimeout     = 30 * time.Second
	backupStepPages    = 128
)

// Options controls bounded waiting for SQLite locks. Zero uses the default.
type Options struct {
	BusyTimeout time.Duration
	ReadOnly    bool
}

// Open opens a SQLite database with bounded lock waiting and a single pooled
// connection. The one-connection pool keeps connection-local pragmas stable.
func Open(path string, opts Options) (*sql.DB, error) {
	if path == "" {
		return nil, errors.New("sqlite: database path is empty")
	}
	if opts.BusyTimeout == 0 {
		opts.BusyTimeout = defaultBusyTimeout
	}
	if opts.BusyTimeout < 0 || opts.BusyTimeout > maxBusyTimeout {
		return nil, fmt.Errorf("sqlite: busy timeout must be between 0 and %s", maxBusyTimeout)
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("sqlite: resolve database path: %w", err)
	}
	uri := (&url.URL{Scheme: "file", Path: filepath.ToSlash(abs)}).String()
	params := url.Values{}
	params.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", opts.BusyTimeout.Milliseconds()))
	params.Add("_pragma", "foreign_keys(1)")
	params.Set("_txlock", "immediate")
	if opts.ReadOnly {
		params.Set("mode", "ro")
	}
	db, err := sql.Open("sqlite", uri+"?"+params.Encode())
	if err != nil {
		return nil, fmt.Errorf("sqlite: open %q: %w", path, err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	return db, nil
}

// WithTransaction runs fn in an IMMEDIATE transaction and rolls back on error
// or panic. It returns the commit error when the callback succeeds.
func WithTransaction(ctx context.Context, db *sql.DB, fn func(*sql.Tx) error) (err error) {
	if db == nil || fn == nil {
		return errors.New("sqlite: transaction requires a database and callback")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("sqlite: begin transaction: %w", err)
	}
	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback()
			panic(p)
		}
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if err = fn(tx); err != nil {
		return fmt.Errorf("sqlite: transaction: %w", err)
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("sqlite: commit transaction: %w", err)
	}
	return nil
}

// IntegrityCheck reports database record/index corruption via PRAGMA
// integrity_check. A healthy database returns nil; any result other than the
// single "ok" row is returned as a descriptive error.
func IntegrityCheck(ctx context.Context, db *sql.DB) error {
	if db == nil {
		return errors.New("sqlite: integrity check requires a database")
	}
	rows, err := db.QueryContext(ctx, "PRAGMA integrity_check")
	if err != nil {
		return fmt.Errorf("sqlite: integrity check: %w", err)
	}
	defer rows.Close()
	var problems []string
	count := 0
	for rows.Next() {
		var result string
		if err := rows.Scan(&result); err != nil {
			return fmt.Errorf("sqlite: read integrity result: %w", err)
		}
		count++
		if result != "ok" {
			problems = append(problems, result)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("sqlite: read integrity results: %w", err)
	}
	if count == 1 && len(problems) == 0 {
		return nil
	}
	if count == 0 && len(problems) == 0 {
		return errors.New("sqlite: integrity check returned no results")
	}
	if count != len(problems) {
		return fmt.Errorf("sqlite: integrity check returned %d rows; expected a single ok row", count)
	}
	return fmt.Errorf("sqlite: integrity check failed: %s", strings.Join(problems, "; "))
}

// Backup creates a consistent online backup of db at destination. The target
// is integrity-checked before this function reports success.
func Backup(ctx context.Context, db *sql.DB, destination string) error {
	if db == nil || destination == "" {
		return errors.New("sqlite: backup requires a database and destination")
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("sqlite: acquire backup connection: %w", err)
	}
	defer conn.Close()
	uri, err := fileURI(destination)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(maxBusyTimeout)
	err = conn.Raw(func(raw any) error {
		backupAPI, ok := raw.(interface {
			NewBackup(string) (*driver.Backup, error)
		})
		if !ok {
			return errors.New("sqlite: configured driver does not support online backup")
		}
		backup, err := backupAPI.NewBackup(uri)
		if err != nil {
			return err
		}
		finished := false
		defer func() {
			if !finished {
				_ = backup.Finish()
			}
		}()
		for {
			if err := ctx.Err(); err != nil {
				return err
			}
			done, err := backup.Step(backupStepPages)
			if err == nil {
				if !done {
					finished = true
					return backup.Finish()
				}
				continue
			}
			var sqliteErr *driver.Error
			if !errors.As(err, &sqliteErr) || (sqliteErr.Code()&0xff != 5 && sqliteErr.Code()&0xff != 6) {
				return err
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("sqlite: online backup lock timeout: %w", err)
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(25 * time.Millisecond):
			}
		}
	})
	if err != nil {
		return fmt.Errorf("sqlite: online backup: %w", err)
	}
	target, err := Open(destination, Options{})
	if err != nil {
		return fmt.Errorf("sqlite: verify backup: %w", err)
	}
	defer target.Close()
	if err := IntegrityCheck(ctx, target); err != nil {
		return fmt.Errorf("sqlite: verify backup: %w", err)
	}
	return nil
}

// Restore replaces db's contents with an online backup from source. The
// destination is integrity-checked after the restore completes.
func Restore(ctx context.Context, db *sql.DB, source string) error {
	if db == nil || source == "" {
		return errors.New("sqlite: restore requires a database and source")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	uri, err := fileURI(source)
	if err != nil {
		return err
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("sqlite: acquire restore connection: %w", err)
	}
	err = conn.Raw(func(raw any) error {
		restoreAPI, ok := raw.(interface {
			NewRestore(string) (*driver.Backup, error)
		})
		if !ok {
			return errors.New("sqlite: configured driver does not support online restore")
		}
		backup, err := restoreAPI.NewRestore(uri)
		if err != nil {
			return err
		}
		finished := false
		defer func() {
			if !finished {
				_ = backup.Finish()
			}
		}()
		for {
			done, err := backup.Step(backupStepPages)
			if err != nil {
				return err
			}
			if !done {
				finished = true
				return backup.Finish()
			}
		}
	})
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("sqlite: online restore: %w", err)
	}
	if err := conn.Close(); err != nil {
		return fmt.Errorf("sqlite: release restore connection: %w", err)
	}
	if err := IntegrityCheck(ctx, db); err != nil {
		return fmt.Errorf("sqlite: verify restored database: %w", err)
	}
	return nil
}

func fileURI(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("sqlite: resolve file path %q: %w", path, err)
	}
	if _, err := os.Stat(filepath.Dir(abs)); err != nil {
		return "", fmt.Errorf("sqlite: destination directory: %w", err)
	}
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(abs)}).String(), nil
}
