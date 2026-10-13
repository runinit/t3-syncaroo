package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/runinit/t3-syncaroo/internal/domain"
)

func TestResolveTargetPathsPrefersV2AndHonorsOverrides(t *testing.T) {
	home := t.TempDir()
	t.Setenv("T3CODE_HOME", home)
	userdata := filepath.Join(home, "userdata")
	if err := os.MkdirAll(userdata, 0o755); err != nil {
		t.Fatal(err)
	}
	v2 := filepath.Join(userdata, "statev2.sqlite")
	if err := os.WriteFile(v2, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	got := ResolveTargetPaths(TargetOverrides{})
	if got.DBPath != v2 || got.StateDir != userdata || got.T3Home != home {
		t.Fatalf("unexpected paths: %+v", got)
	}
	os.Unsetenv("T3CODE_HOME")
	customDB := filepath.Join(t.TempDir(), "other", "custom.sqlite")
	customAttachments := filepath.Join(t.TempDir(), "assets")
	got = ResolveTargetPaths(TargetOverrides{DBPath: customDB, AttachmentsDir: customAttachments})
	if got.DBPath != customDB || got.StateDir != filepath.Dir(customDB) || got.T3Home != filepath.Dir(filepath.Dir(customDB)) || got.AttachmentsDir != customAttachments {
		t.Fatalf("overrides not honored: %+v", got)
	}
}

func TestProviderSelectionUsesCacheFallbackAndOptions(t *testing.T) {
	paths := TargetPaths{T3Home: t.TempDir()}
	cacheDir := filepath.Join(paths.T3Home, "caches")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cacheDir, "codex.json"), []byte(`{"models":[{"id":"gpt-a"},"gpt-b"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	got := ResolveProviderSelection(paths, domain.SourceCodex, "gpt-missing", "high", "")
	if got.Model != "gpt-a" || got.Warning == "" || got.ProviderName != "codex" || !reflect.DeepEqual(got.Options, []ProviderOption{{ID: "reasoningEffort", Value: "high"}, {ID: "serviceTier", Value: "default"}}) {
		t.Fatalf("unexpected selection: %+v", got)
	}
	got = ResolveProviderSelection(paths, domain.SourceClaude, "requested", "", "alt")
	if got.Model != "requested" || got.ProviderName != "claudeAgent" || got.InstanceID != "alt" {
		t.Fatalf("unexpected uncached model selection: %+v", got)
	}
}

func TestListProviderInstancesFiltersDisabledAndDrivers(t *testing.T) {
	paths := TargetPaths{SettingsPath: filepath.Join(t.TempDir(), "settings.json")}
	if err := os.WriteFile(paths.SettingsPath, []byte(`{"providerInstances":{"one":{"driver":"codex"},"off":{"driver":"codex","enabled":false},"other":{"driver":"claudeAgent"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	got := ListProviderInstances(paths, domain.SourceCodex)
	if len(got) != 2 || got[0] != "codex" || got[1] != "one" {
		t.Fatalf("unexpected instances: %v", got)
	}
}
