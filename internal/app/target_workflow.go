package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/CarlosGtrz/t3-import/internal/checkpoint"
	"github.com/CarlosGtrz/t3-import/internal/domain"
	"github.com/CarlosGtrz/t3-import/internal/identity"
	"github.com/CarlosGtrz/t3-import/internal/target/cache"
	"github.com/CarlosGtrz/t3-import/internal/target/config"
	"github.com/CarlosGtrz/t3-import/internal/target/ledger"
	"github.com/CarlosGtrz/t3-import/internal/target/legacy"
	"github.com/CarlosGtrz/t3-import/internal/target/lock"
	targetruntime "github.com/CarlosGtrz/t3-import/internal/target/runtime"
	"github.com/CarlosGtrz/t3-import/internal/target/schema"
	"github.com/CarlosGtrz/t3-import/internal/target/sqlite"
	"github.com/CarlosGtrz/t3-import/internal/target/v2"
)

const maxSafeEvents = 900

type loadedSession struct {
	summary      domain.SourceSummary
	conversation domain.CanonicalConversation
}

type sessionAssessment struct {
	preview      PreviewSession
	conversation domain.CanonicalConversation
	imports      []ledger.Record
	threadPlans  []plannedThread
}

type plannedThread struct {
	thread             domain.CanonicalThread
	threadID           string
	projectID          string
	status             string
	fingerprint        string
	oldRecords         []ledger.Record
	provider           config.ProviderSelection
	legacyPlan         legacy.Plan
	v2Plan             v2.Plan
	checkpoint         json.RawMessage
	resumable          bool
	recovered          bool
	recoveryOldRecords []ledger.Record
	adopted            bool
	adoptedRecord      *ledger.Record
	adoptHeadEvent     *v2.Event
	firstSequence      int64
	lastSequence       int64
	warnings           []string
	upgraded           bool
}

func discoveryOptions(request Request) (domain.DiscoveryOptions, error) {
	options := domain.DiscoveryOptions{}
	if request.Workspace != "" {
		options.Workspace = &request.Workspace
	}
	if request.IncludeIncomplete {
		include := true
		options.IncludeIncomplete = &include
	}
	if request.Since != "" {
		since, err := time.Parse(time.RFC3339Nano, request.Since)
		if err != nil {
			return options, fmt.Errorf("invalid ISO date/time %q: %w", request.Since, err)
		}
		options.Since = &since
	}
	return options, nil
}

func openValidatedTarget(ctx context.Context, paths config.TargetPaths, readOnly bool) (*sql.DB, schema.Info, error) {
	if _, err := os.Stat(paths.DBPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, schema.Info{}, withExitCode(4, fmt.Errorf("T3 database not found: %s", paths.DBPath))
		}
		return nil, schema.Info{}, withExitCode(3, fmt.Errorf("inspect T3 database: %w", err))
	}
	db, err := sqlite.Open(paths.DBPath, sqlite.Options{ReadOnly: readOnly})
	if err != nil {
		return nil, schema.Info{}, withExitCode(3, err)
	}
	info, err := schema.Validate(ctx, db)
	if err != nil {
		_ = db.Close()
		return nil, schema.Info{}, withExitCode(3, err)
	}
	return db, info, nil
}

func (s *Service) show(ctx context.Context, request Request) (any, error) {
	if !request.Source.Valid() {
		return nil, errors.New("source is required")
	}
	id := request.ThreadID
	if id == "" && len(request.SessionIDs) == 1 {
		id = request.SessionIDs[0]
	}
	if id == "" {
		return nil, errors.New("threadId is required")
	}
	adapter, err := s.Sources.Get(request.Source)
	if err != nil {
		return nil, withExitCode(2, err)
	}
	options, err := discoveryOptions(request)
	if err != nil {
		return nil, err
	}
	found, err := adapter.DiscoverWithOutcomes(ctx, options)
	if err != nil {
		return nil, withExitCode(5, err)
	}
	for _, summary := range found.Summaries {
		if summary.ID != id {
			continue
		}
		conversation, err := adapter.Load(ctx, summary, options)
		if err != nil {
			return nil, withExitCode(5, err)
		}
		return map[string]any{"schemaVersion": 1, "source": conversation.Summary, "fingerprint": conversation.Fingerprint, "tasks": summarizeThreadDetails(conversation)}, nil
	}
	return nil, withExitCode(5, fmt.Errorf("conversation not found: %s", id))
}

func summarizeThreadDetails(conversation domain.CanonicalConversation) []map[string]any {
	result := make([]map[string]any, 0, len(conversation.Threads))
	for _, sourceThread := range conversation.Threads {
		thread := compactThread(sourceThread)
		messages, activities, plans, attachments := 0, 0, 0, 0
		for _, turn := range thread.Turns {
			messages += 1 + len(turn.Assistant)
			activities += len(turn.Activities)
			plans += len(turn.Plans)
			attachments += len(turn.User.Attachments)
		}
		result = append(result, map[string]any{"sourceKey": thread.SourceKey, "title": thread.Title, "currentBranch": thread.CurrentBranch, "resumable": len(thread.ResumeCursor) > 0, "turns": len(thread.Turns), "messages": messages, "activities": activities, "plans": plans, "attachments": attachments, "warnings": thread.Warnings})
	}
	return result
}

func (s *Service) doctor(ctx context.Context) (any, error) {
	result := map[string]any{"schemaVersion": 1, "target": targetPathsJSON{T3Home: s.Paths.T3Home, StateDir: s.Paths.StateDir, DBPath: s.Paths.DBPath, AttachmentsDir: s.Paths.AttachmentsDir}, "runtime": targetruntime.InspectRuntime(ctx, s.Paths), "sources": map[string]any{}, "indexedDbCaches": cacheDiscover(), "stagingDirectories": []string{}}
	databaseInfo := map[string]any{"exists": false}
	if _, err := os.Stat(s.Paths.DBPath); err == nil {
		db, info, openErr := openValidatedTarget(ctx, s.Paths, true)
		if openErr != nil {
			databaseInfo = map[string]any{"exists": true, "compatible": false, "error": openErr.Error()}
		} else {
			databaseInfo = map[string]any{"exists": true, "compatible": true, "profile": info.Profile, "migration": info.Migration, "integrity": info.Integrity, "events": info.EventCount}
			_ = db.Close()
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		databaseInfo = map[string]any{"exists": true, "compatible": false, "error": err.Error()}
	}
	result["database"] = databaseInfo
	sources := result["sources"].(map[string]any)
	for _, source := range s.Sources.Names() {
		adapter, err := s.Sources.Get(source)
		if err != nil {
			sources[string(source)] = map[string]any{"available": false, "error": err.Error()}
			continue
		}
		found, err := adapter.DiscoverWithOutcomes(ctx, domain.DiscoveryOptions{})
		if err != nil {
			sources[string(source)] = map[string]any{"available": false, "error": err.Error()}
			continue
		}
		workspaces := map[string]bool{}
		for _, summary := range found.Summaries {
			workspaces[summary.Workspace] = true
		}
		sources[string(source)] = map[string]any{"available": true, "conversations": len(found.Summaries), "workspaces": len(workspaces), "outcomes": found.Outcomes}
	}
	entries, err := os.ReadDir(s.Paths.AttachmentsDir)
	if err == nil {
		staging := []string{}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".t3-import-staging-") {
				staging = append(staging, entry.Name())
			}
		}
		result["stagingDirectories"] = staging
	}
	return result, nil
}

func cacheDiscover() []map[string]any {
	profiles, err := cache.Discover(cache.Options{})
	if err != nil {
		return []map[string]any{{"error": err.Error()}}
	}
	result := make([]map[string]any, 0, len(profiles))
	for _, profile := range profiles {
		result = append(result, map[string]any{"profilePath": profile.ProfilePath, "cachePaths": profile.CachePaths, "modifiedAt": profile.ModifiedAt})
	}
	return result
}

func (s *Service) resetCache(ctx context.Context, request Request) (any, error) {
	if !request.Confirmed {
		return nil, errors.New("cache reset requires confirmed: true")
	}
	if _, err := targetruntime.AssertT3Closed(ctx, s.Paths); err != nil {
		return nil, withExitCode(4, err)
	}
	release, err := lock.Acquire(s.Paths.StateDir)
	if err != nil {
		return nil, withExitCode(4, err)
	}
	defer release()
	result, err := cache.Reset(ctx, s.Paths, cache.Options{})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func compactThread(thread domain.CanonicalThread) domain.CanonicalThread {
	copy := thread
	copy.Turns = append([]domain.CanonicalTurn(nil), thread.Turns...)
	before := 0
	after := 0
	for index := range copy.Turns {
		turn := &copy.Turns[index]
		activities := turn.Activities
		before += len(activities)
		selected := map[int]bool{}
		latestReasoning, latestPlan, representativeTool := -1, -1, -1
		latestOther := map[string]int{}
		priority := func(activity domain.CanonicalActivity) int {
			if activity.Tone == domain.ToneError || activity.Payload["status"] == "failed" {
				return 100
			}
			switch activity.Payload["itemType"] {
			case "file_change":
				return 90
			case "mcp_tool_call", "dynamic_tool_call":
				return 80
			case "command_execution":
				return 70
			case "web_search":
				return 60
			case "image_view":
				return 50
			default:
				return 40
			}
		}
		for i, activity := range activities {
			switch {
			case activity.Kind == "context-window.updated":
				latestOther[activity.Kind] = i
			case activity.Kind == "reasoning.summary":
				latestReasoning = i
			case activity.Kind == "turn.plan.updated":
				latestPlan = i
			case activity.Kind == "tool.completed":
				if representativeTool < 0 || priority(activity) >= priority(activities[representativeTool]) {
					representativeTool = i
				}
			case activity.Kind == "context-compaction" || activity.Tone == domain.ToneError || activity.Tone == domain.ToneApproval:
				selected[i] = true
			default:
				latestOther[activity.Kind] = i
			}
		}
		for _, i := range []int{latestReasoning, latestPlan, representativeTool} {
			if i >= 0 {
				selected[i] = true
			}
		}
		for _, i := range latestOther {
			selected[i] = true
		}
		turn.Activities = make([]domain.CanonicalActivity, 0, len(selected))
		for i, activity := range activities {
			if selected[i] {
				turn.Activities = append(turn.Activities, activity)
			}
		}
		after += len(turn.Activities)
	}
	if after < before {
		copy.Warnings = append(append([]string(nil), thread.Warnings...), fmt.Sprintf("Compacted %d source activities to %d import activities for T3 startup compatibility.", before, after))
	}
	return copy
}

func terminalThread(thread domain.CanonicalThread) domain.CanonicalThread {
	thread = compactThread(thread)
	turns := make([]domain.CanonicalTurn, 0, len(thread.Turns))
	for _, turn := range thread.Turns {
		if turn.Status.Terminal() {
			turns = append(turns, turn)
		}
	}
	thread.Turns = turns
	return thread
}

func (s *Service) resetOption(request Request) bool {
	return request.ResetCache == nil || *request.ResetCache
}

func (s *Service) targetRecords(ctx context.Context, source domain.SourceName) ([]ledger.Record, error) {
	path, err := ledger.DefaultPath()
	if err != nil {
		return nil, err
	}
	store, err := ledger.Open(path)
	if err != nil {
		return nil, err
	}
	defer store.Close()
	currentTarget := identity.TargetID(s.Paths.DBPath)
	targetIDs := []string{currentTarget}
	if filepath.Base(s.Paths.DBPath) == "statev2.sqlite" {
		targetIDs = append(targetIDs, identity.TargetID(filepath.Join(s.Paths.StateDir, "state.sqlite")))
	}
	records, err := store.ListForTargets(ctx, targetIDs, source)
	if err != nil {
		return nil, err
	}
	// Once an upgrade has been recorded under the current database identity,
	// prefer that row over its retained pre-upgrade copy for the same task.
	current := map[string]bool{}
	for _, row := range records {
		if row.TargetID == currentTarget {
			current[string(row.Source)+"\x00"+row.ThreadID] = true
		}
	}
	filtered := records[:0]
	for _, row := range records {
		if row.TargetID != currentTarget && current[string(row.Source)+"\x00"+row.ThreadID] {
			continue
		}
		filtered = append(filtered, row)
	}
	return filtered, nil
}

func matchRecord(records []ledger.Record, thread domain.CanonicalThread) ([]ledger.Record, *ledger.Record) {
	var exact, exactCanonical, session, sessionCanonical []ledger.Record
	for _, row := range records {
		if row.SourceKey == thread.SourceKey || row.CurrentSourceKey == thread.SourceKey {
			exact = append(exact, row)
			if row.IsCanonical == nil || *row.IsCanonical {
				exactCanonical = append(exactCanonical, row)
			}
		} else if row.SourceSessionID == thread.SourceSessionID && (thread.Source == domain.SourceClaude || thread.LeafID == nil || row.SourceLeafID == nil || *row.SourceLeafID == *thread.LeafID) {
			session = append(session, row)
			if row.IsCanonical == nil || *row.IsCanonical {
				sessionCanonical = append(sessionCanonical, row)
			}
		}
	}
	candidates := exactCanonical
	if len(candidates) == 0 && len(exact) == 0 {
		candidates = sessionCanonical
	}
	if len(candidates) == 0 {
		if len(exact) > 0 {
			candidates = exact
		} else {
			candidates = session
		}
	}
	if len(candidates) == 1 {
		row := candidates[0]
		if row.IsCanonical == nil || *row.IsCanonical {
			return candidates, &row
		}
	}
	return candidates, nil
}

func projectForWorkspace(ctx context.Context, db *sql.DB, workspace string) (string, bool, error) {
	var id string
	err := db.QueryRowContext(ctx, `SELECT project_id FROM projection_projects WHERE workspace_root=? AND deleted_at IS NULL ORDER BY project_id LIMIT 1`, workspace).Scan(&id)
	if err == sql.ErrNoRows {
		return identity.ProjectID(workspace), false, nil
	}
	if err != nil {
		return "", false, err
	}
	return id, true, nil
}

func threadID(thread domain.CanonicalThread) string {
	return identity.ThreadID(thread.SourceKey, thread.SourceSessionID, thread.Source == domain.SourceCodex)
}

func (s *Service) planThread(ctx context.Context, info schema.Info, db *sql.DB, thread domain.CanonicalThread, providerOverride, projectOverride string, createProject bool, disableResume bool) (plannedThread, error) {
	thread = terminalThread(thread)
	if len(thread.Turns) == 0 {
		return plannedThread{}, withExitCode(4, fmt.Errorf("conversation %s has no terminal turns to import", thread.SourceSessionID))
	}
	provider := config.ResolveProviderSelection(s.Paths, thread.Source, thread.Model, valueOf(thread.Effort), providerOverride)
	projectID, exists, err := projectForWorkspace(ctx, db, thread.Workspace)
	if err != nil {
		return plannedThread{}, err
	}
	if projectOverride != "" {
		projectID = projectOverride
		var present int
		if err := db.QueryRowContext(ctx, `SELECT 1 FROM projection_projects WHERE project_id=? AND deleted_at IS NULL`, projectID).Scan(&present); err == nil {
			exists = true
		} else if err == sql.ErrNoRows {
			exists = false
		} else {
			return plannedThread{}, err
		}
	}
	createProject = createProject && !exists
	resumable := !disableResume && thread.CurrentBranch && len(thread.ResumeCursor) > 0
	result := plannedThread{thread: thread, threadID: threadID(thread), projectID: projectID, provider: provider, resumable: resumable}
	checkpointValue, err := checkpoint.ForThread(thread)
	if err != nil {
		return plannedThread{}, err
	}
	result.checkpoint, err = json.Marshal(checkpointValue)
	if err != nil {
		return plannedThread{}, err
	}
	if info.Profile == schema.ProfileLegacy {
		legacyProvider := legacy.Provider{ProviderName: provider.ProviderName, InstanceID: provider.InstanceID, AdapterKey: provider.AdapterKey, Model: provider.Model, Options: providerOptions(provider.Options)}
		target := legacy.Target{TargetID: identity.TargetID(s.Paths.DBPath), ProjectID: projectID, ThreadID: result.threadID, IdentitySeed: thread.SourceKey, Workspace: thread.Workspace, AttachmentsDir: s.Paths.AttachmentsDir, CreateProject: createProject, Migration: info.Migration}
		result.legacyPlan = legacy.PlanImport(thread, target, legacyProvider, resumable)
		return result, nil
	}
	result.v2Plan, err = v2.BuildPlanWithRuntimeOptions(thread, result.threadID, projectID, provider.InstanceID, provider.Model, providerOptionMap(provider.Options), createProject, s.Paths.AttachmentsDir, resumable)
	return result, err
}

func providerOptions(options []config.ProviderOption) []map[string]any {
	result := make([]map[string]any, 0, len(options))
	for _, option := range options {
		result = append(result, map[string]any{"id": option.ID, "value": option.Value})
	}
	return result
}

func providerOptionMap(options []config.ProviderOption) map[string]any {
	result := make(map[string]any, len(options))
	for _, option := range options {
		result[option.ID] = option.Value
	}
	return result
}

func v2PlanForRecord(thread domain.CanonicalThread, record ledger.Record, provider config.ProviderSelection, attachmentsDir string) (v2.Plan, error) {
	if record.IdentitySeed != "" {
		thread.SourceKey = record.IdentitySeed
	}
	return v2.BuildPlanWithRuntimeOptions(thread, record.ThreadID, record.ProjectID, provider.InstanceID, provider.Model, providerOptionMap(provider.Options), false, attachmentsDir, record.Resumable)
}

func valueOf(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func eventCount(plan plannedThread) int {
	if plan.adopted {
		return 0
	}
	if plan.v2Plan.ThreadID != "" {
		count := len(plan.v2Plan.Events)
		if plan.v2Plan.Project != nil {
			count++
		}
		return count
	}
	return len(plan.legacyPlan.Events)
}

func sortedIDs(ids []string) []string {
	copy := append([]string(nil), ids...)
	sort.Strings(copy)
	return copy
}
