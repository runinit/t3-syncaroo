// Package lock provides an importer-only process lock in the T3 state
// directory. It never mutates T3-owned SQLite data.
package lock

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type record struct {
	PID       int    `json:"pid"`
	StartedAt string `json:"startedAt"`
}

// Acquire creates .t3-import.lock. A lock belonging to a dead process is
// removed and retried; malformed locks fail closed so a live writer is never
// displaced based on unreadable state.
func Acquire(stateDir string) (func(), error) {
	if stateDir == "" {
		return nil, fmt.Errorf("importer lock: state directory is empty")
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, fmt.Errorf("importer lock: create state directory: %w", err)
	}
	path := filepath.Join(stateDir, ".t3-import.lock")
	for attempt := 0; attempt < 2; attempt++ {
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			data, marshalErr := json.Marshal(record{PID: os.Getpid(), StartedAt: time.Now().UTC().Format(time.RFC3339Nano)})
			if marshalErr == nil {
				_, err = file.Write(data)
			}
			if err == nil {
				err = file.Sync()
			}
			closeErr := file.Close()
			if err == nil {
				err = closeErr
			}
			if err != nil {
				_ = os.Remove(path)
				return nil, fmt.Errorf("importer lock: write lock: %w", err)
			}
			return func() { _ = os.Remove(path) }, nil
		}
		if !os.IsExist(err) {
			return nil, fmt.Errorf("importer lock: create %s: %w", path, err)
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil, fmt.Errorf("importer lock: existing lock cannot be read at %s: %w", path, readErr)
		}
		var previous record
		if err := json.Unmarshal(data, &previous); err != nil || previous.PID <= 0 {
			return nil, fmt.Errorf("importer lock: existing lock is malformed at %s; inspect or remove it manually", path)
		}
		if processAlive(previous.PID) {
			return nil, fmt.Errorf("another t3-import process is running (PID %d)", previous.PID)
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return nil, fmt.Errorf("importer lock: remove stale lock %s: %w", path, err)
		}
	}
	return nil, fmt.Errorf("importer lock: could not acquire %s", path)
}
