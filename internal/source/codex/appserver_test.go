package codex

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAppServerMetadataAndUnavailableFallback(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "codex")
	script := `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"thread/list"'*) echo '{"id":2,"result":{"data":[{"id":"abc","name":"App title","updatedAt":1760000000}]}}' ;;
    *'"method":"thread/read"'*) echo '{"id":2,"result":{"thread":{"id":"abc","cwd":"/workspace","model":"gpt-test","turns":[]}}}' ;;
    *'"id":1'*) echo '{"id":1,"result":{}}' ;;
  esac
done
`
	if err := os.WriteFile(bin, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_BIN", bin)
	got, err := listAppThreads(context.Background(), "")
	if err != nil || got["abc"]["name"] != "App title" {
		t.Fatalf("metadata = %#v, %v", got, err)
	}
	thread := readAppThread(context.Background(), "abc")
	if thread == nil || thread["model"] != "gpt-test" {
		t.Fatalf("thread = %#v", thread)
	}
	root := t.TempDir()
	rolloutDir := filepath.Join(root, "sessions", "2025")
	if err := os.MkdirAll(rolloutDir, 0700); err != nil {
		t.Fatal(err)
	}
	rollout := `{"type":"session_meta","timestamp":"2025-01-01T00:00:00Z","payload":{"id":"abc","cwd":"/workspace"}}` + "\n"
	if err := os.WriteFile(filepath.Join(rolloutDir, "rollout.jsonl"), []byte(rollout), 0600); err != nil {
		t.Fatal(err)
	}
	discovered, err := NewAt(root).DiscoverWithOutcomes(context.Background(), structOptions(time.Time{}))
	if err != nil || len(discovered.Summaries) != 1 || discovered.Summaries[0].Title != "App title" {
		t.Fatalf("discovery enrichment = %#v, %v", discovered, err)
	}
	t.Setenv("CODEX_BIN", filepath.Join(t.TempDir(), "missing-codex"))
	if got := readAppThread(context.Background(), "abc"); got != nil {
		t.Fatalf("unavailable app-server returned %#v", got)
	}
}
