// Package config resolves T3 paths and provider settings without opening T3's database.
package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"

	"github.com/CarlosGtrz/t3-import/internal/domain"
)

type TargetPaths struct {
	T3Home           string
	StateDir         string
	DBPath           string
	AttachmentsDir   string
	RuntimeStatePath string
	SettingsPath     string
}

type TargetOverrides struct {
	T3Home           string
	DBPath           string
	AttachmentsDir   string
	ProviderInstance string
}

// ResolveTargetPaths follows T3CODE_HOME, explicit paths, and the statev2-first
// database preference used by the TypeScript importer. It does not create files.
func ResolveTargetPaths(overrides TargetOverrides) TargetPaths {
	explicitHome := overrides.T3Home
	if explicitHome == "" {
		explicitHome = os.Getenv("T3CODE_HOME")
	}
	defaultHome := explicitHome
	if defaultHome == "" {
		if home, err := os.UserHomeDir(); err == nil {
			defaultHome = filepath.Join(home, ".t3")
		}
	}
	defaultHome = absolute(defaultHome)
	state := filepath.Join(defaultHome, "userdata")
	db := overrides.DBPath
	if db != "" {
		db = absolute(db)
	} else {
		v2 := filepath.Join(state, "statev2.sqlite")
		if exists(v2) {
			db = v2
		} else {
			db = filepath.Join(state, "state.sqlite")
		}
	}
	stateDir := filepath.Dir(db)
	home := defaultHome
	if overrides.DBPath != "" && explicitHome == "" {
		home = filepath.Dir(stateDir)
	}
	attachments := filepath.Join(stateDir, "attachments")
	if overrides.AttachmentsDir != "" {
		attachments = absolute(overrides.AttachmentsDir)
	}
	return TargetPaths{
		T3Home: home, StateDir: stateDir, DBPath: db,
		AttachmentsDir:   attachments,
		RuntimeStatePath: filepath.Join(stateDir, "server-runtime.json"),
		SettingsPath:     filepath.Join(stateDir, "settings.json"),
	}
}

func absolute(path string) string {
	if path == "" {
		return ""
	}
	p, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	return p
}
func exists(path string) bool { _, err := os.Stat(path); return err == nil }

type ProviderOption struct {
	ID    string `json:"id"`
	Value any    `json:"value"`
}
type ProviderSelection struct {
	InstanceID   string           `json:"instanceId"`
	ProviderName string           `json:"providerName"`
	AdapterKey   string           `json:"adapterKey"`
	Model        string           `json:"model"`
	Options      []ProviderOption `json:"options"`
	Warning      string           `json:"warning,omitempty"`
}

func providerName(source domain.SourceName) string {
	if source == domain.SourceCodex {
		return "codex"
	}
	return "claudeAgent"
}

// ListProviderInstances returns the default provider instance followed by enabled
// configured instances using its driver in stable identifier order.
func ListProviderInstances(paths TargetPaths, source domain.SourceName) []string {
	driver := providerName(source)
	ids := []string{driver}
	settings, ok := readObject(paths.SettingsPath)
	instances, ok2 := settings["providerInstances"].(map[string]any)
	if !ok || !ok2 {
		return ids
	}
	keys := make([]string, 0, len(instances))
	for id := range instances {
		keys = append(keys, id)
	}
	sort.Strings(keys)
	for _, id := range keys {
		raw := instances[id]
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if entry["enabled"] == false {
			continue
		}
		if entry["driver"] == driver && id != driver {
			ids = append(ids, id)
		}
	}
	return ids
}

// ResolveProviderSelection applies T3's model-cache fallback rules to a source model.
func ResolveProviderSelection(paths TargetPaths, source domain.SourceName, requestedModel, effort, overrideInstance string) ProviderSelection {
	provider := providerName(source)
	instance := overrideInstance
	if instance == "" {
		instance = provider
	}
	models := cacheModels(paths, instance)
	requested := requestedModel
	if requested == "default" {
		requested = ""
	}
	model := "default"
	if requested != "" && (len(models) == 0 || contains(models, requested)) {
		model = requested
	} else if len(models) > 0 {
		model = models[0]
	} else if requested != "" {
		model = requested
	}
	selection := ProviderSelection{InstanceID: instance, ProviderName: provider, AdapterKey: provider, Model: model, Options: []ProviderOption{}}
	if requested != "" && len(models) > 0 && !contains(models, requested) {
		selection.Warning = "Source model '" + requested + "' is unavailable in T3 instance '" + instance + "'; using '" + model + "'."
	}
	if effort != "" {
		selection.Options = append(selection.Options, ProviderOption{ID: "reasoningEffort", Value: effort})
	}
	if source == domain.SourceCodex {
		selection.Options = append(selection.Options, ProviderOption{ID: "serviceTier", Value: "default"})
	}
	return selection
}

func cacheModels(paths TargetPaths, instance string) []string {
	obj, ok := readObject(filepath.Join(paths.T3Home, "caches", instance+".json"))
	if !ok {
		return nil
	}
	items, ok := obj["models"].([]any)
	if !ok {
		return nil
	}
	models := make([]string, 0, len(items))
	for _, item := range items {
		if s, ok := item.(string); ok {
			models = append(models, s)
			continue
		}
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		for _, key := range []string{"id", "model", "value"} {
			if s, ok := entry[key].(string); ok && s != "" {
				models = append(models, s)
				break
			}
		}
	}
	return models
}
func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
func readObject(path string) (map[string]any, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var value map[string]any
	if json.Unmarshal(data, &value) != nil || value == nil {
		return nil, false
	}
	return value, true
}
