// Package backup creates verified SQLite snapshots before an importer write.
package backup

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/CarlosGtrz/t3-import/internal/target/sqlite"
)

func Create(ctx context.Context, db *sql.DB, stateDir string) (string, error) {
	if stateDir == "" {
		return "", fmt.Errorf("backup: state directory is empty")
	}
	directory := filepath.Join(stateDir, "t3-import-backups")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", fmt.Errorf("backup: create directory: %w", err)
	}
	path := filepath.Join(directory, "state-before-import-"+time.Now().UTC().Format("20060102T150405.000000000Z")+".sqlite")
	if _, err := os.Lstat(path); err == nil {
		return "", fmt.Errorf("backup: destination already exists: %s", path)
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("backup: inspect destination: %w", err)
	}
	if err := sqlite.Backup(ctx, db, path); err != nil {
		return "", fmt.Errorf("backup: create verified SQLite backup: %w", err)
	}
	return path, nil
}
