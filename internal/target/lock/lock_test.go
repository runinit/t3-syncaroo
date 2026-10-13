package lock

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAcquireExcludesConcurrentWriterAndRemovesStaleLock(t *testing.T) {
	dir := t.TempDir()
	release, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(dir); err == nil || !strings.Contains(err.Error(), "another t3-import process") {
		t.Fatalf("concurrent acquire error = %v", err)
	}
	release()
	if err := os.WriteFile(filepath.Join(dir, ".t3-import.lock"), []byte(`{"pid":2147483647,"startedAt":"old"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	release, err = Acquire(dir)
	if err != nil {
		t.Fatalf("acquire after stale lock: %v", err)
	}
	release()
}

func TestAcquireFailsClosedOnMalformedLock(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".t3-import.lock")
	if err := os.WriteFile(path, []byte("not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(dir); err == nil || !strings.Contains(err.Error(), "malformed") {
		t.Fatalf("malformed lock error = %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("malformed lock should be preserved: %v", err)
	}
}
