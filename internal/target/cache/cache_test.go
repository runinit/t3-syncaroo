package cache

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/runinit/t3-syncaroo/internal/target/config"
)

func putCache(t *testing.T, profile, body string) string {
	t.Helper()
	p := filepath.Join(profile, "IndexedDB", cacheNames[0])
	if err := os.MkdirAll(p, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(p, "data.log"), []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	return p
}
func TestDiscoverUsesPlatformRootAndNewestProfile(t *testing.T) {
	base := t.TempDir()
	old := filepath.Join(base, "t3code-v2")
	newer := filepath.Join(base, "T3 Code")
	oldCache := putCache(t, old, "old")
	newCache := putCache(t, newer, "new")
	oldTime := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	newTime := oldTime.Add(time.Hour)
	for _, entry := range []struct {
		path string
		time time.Time
	}{{oldCache, oldTime}, {filepath.Join(oldCache, "data.log"), oldTime}, {newCache, newTime}, {filepath.Join(newCache, "data.log"), newTime}} {
		if err := os.Chtimes(entry.path, entry.time, entry.time); err != nil {
			t.Fatal(err)
		}
	}
	profiles, err := Discover(Options{Platform: "win32", Environment: map[string]string{"APPDATA": base}, UserHome: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 2 {
		t.Fatalf("profiles=%d", len(profiles))
	}
	if profiles[0].ProfilePath != newer {
		t.Fatalf("newest=%q", profiles[0].ProfilePath)
	}
}

func TestResetBacksUpAndLeavesOlderProfile(t *testing.T) {
	base := t.TempDir()
	first := filepath.Join(base, "t3code-v2")
	second := filepath.Join(base, "T3 Code")
	cache1 := putCache(t, first, "older")
	cache2 := putCache(t, second, "newer")
	old := time.Now().Add(-time.Hour)
	newer := time.Now()
	for _, path := range []string{cache1, filepath.Join(cache1, "data.log")} {
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{cache2, filepath.Join(cache2, "data.log")} {
		if err := os.Chtimes(path, newer, newer); err != nil {
			t.Fatal(err)
		}
	}
	result, err := Reset(context.Background(), config.TargetPaths{StateDir: filepath.Join(base, "state")}, Options{Platform: "linux", Environment: map[string]string{"XDG_CONFIG_HOME": base}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Profile == nil || *result.Profile != second {
		t.Fatalf("profile=%v", result.Profile)
	}
	if len(result.Warnings) != 1 {
		t.Fatalf("warnings=%v", result.Warnings)
	}
	if _, err = os.Stat(cache2); !os.IsNotExist(err) {
		t.Fatalf("selected cache still exists: %v", err)
	}
	if _, err = os.Stat(cache1); err != nil {
		t.Fatalf("older cache missing: %v", err)
	}
	backup := filepath.Join(*result.Backup, filepath.Base(second), cacheNames[0], "data.log")
	data, err := os.ReadFile(backup)
	if err != nil || string(data) != "newer" {
		t.Fatalf("backup data=%q err=%v", data, err)
	}
}

func TestResetRefusesSymlinkAndRestoresOriginal(t *testing.T) {
	base := t.TempDir()
	profile := filepath.Join(base, "T3 Code")
	cache := putCache(t, profile, "present")
	if err := os.Symlink(filepath.Join(base, "outside"), filepath.Join(cache, "link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	_, err := Reset(context.Background(), config.TargetPaths{StateDir: filepath.Join(base, "state")}, Options{Platform: "linux", Environment: map[string]string{"XDG_CONFIG_HOME": base}})
	if err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("err=%v", err)
	}
	if _, err = os.Stat(filepath.Join(cache, "data.log")); err != nil {
		t.Fatalf("original was not restored: %v", err)
	}
}

func TestDiscoverHonorsUserDataOverride(t *testing.T) {
	profile := filepath.Join(t.TempDir(), "chosen")
	putCache(t, profile, "x")
	got, err := Discover(Options{Environment: map[string]string{"T3_CODE_USER_DATA": profile}})
	if err != nil || len(got) != 1 || got[0].ProfilePath != profile {
		t.Fatalf("got=%v err=%v", got, err)
	}
}
