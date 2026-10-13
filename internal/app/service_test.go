package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CarlosGtrz/t3-import/internal/checkpoint"
	"github.com/CarlosGtrz/t3-import/internal/domain"
	"github.com/CarlosGtrz/t3-import/internal/identity"
	"github.com/CarlosGtrz/t3-import/internal/source/registry"
	"github.com/CarlosGtrz/t3-import/internal/target/config"
	"github.com/CarlosGtrz/t3-import/internal/target/ledger"
	"github.com/CarlosGtrz/t3-import/internal/target/sqlite"
	"github.com/CarlosGtrz/t3-import/internal/target/v2"
)

type fixedSource struct {
	conversation domain.CanonicalConversation
	loads        int
}

func (f *fixedSource) Name() domain.SourceName { return f.conversation.Summary.Source }
func (f *fixedSource) Discover(_ context.Context, _ domain.DiscoveryOptions) ([]domain.SourceSummary, error) {
	return []domain.SourceSummary{f.conversation.Summary}, nil
}
func (f *fixedSource) DiscoverWithOutcomes(ctx context.Context, options domain.DiscoveryOptions) (domain.SourceDiscoveryResult, error) {
	summaries, err := f.Discover(ctx, options)
	return domain.SourceDiscoveryResult{Summaries: summaries, Outcomes: []domain.SessionOutcomeRecord{}}, err
}
func (f *fixedSource) Load(_ context.Context, summary domain.SourceSummary, _ domain.DiscoveryOptions) (domain.CanonicalConversation, error) {
	f.loads++
	conversation := f.conversation
	conversation.Summary = summary
	return conversation, nil
}

func TestExecuteRejectsStaleSessionSelectionBeforeLoading(t *testing.T) {
	root := t.TempDir()
	t.Setenv("T3_IMPORT_DATA_DIR", filepath.Join(root, "ledger"))
	paths := makeLegacyTarget(t, filepath.Join(root, "state"))
	source := &fixedSource{conversation: sampleConversation()}
	service := &Service{Paths: paths, Sources: registry.NewWith(source)}
	_, err := service.Call(context.Background(), Request{Action: "execute", Source: domain.SourceClaude, Workspace: "/workspace", SessionIDs: []string{"disappeared"}, Confirmed: true})
	if err == nil || !strings.Contains(err.Error(), "selected source session disappeared") {
		t.Fatalf("stale selection error = %v", err)
	}
	if source.loads != 0 {
		t.Fatalf("loaded %d sessions after selection disappeared", source.loads)
	}
}

func TestExecuteRefusesLiveT3BeforeLoadingOrWriting(t *testing.T) {
	root := t.TempDir()
	t.Setenv("T3_IMPORT_DATA_DIR", filepath.Join(root, "ledger"))
	paths := makeLegacyTarget(t, filepath.Join(root, "state"))
	if err := os.WriteFile(paths.RuntimeStatePath, []byte(fmt.Sprintf(`{"pid":%d}`, os.Getpid())), 0o600); err != nil {
		t.Fatal(err)
	}
	source := &fixedSource{conversation: sampleConversation()}
	service := &Service{Paths: paths, Sources: registry.NewWith(source)}
	_, err := service.Call(context.Background(), Request{Action: "execute", Source: domain.SourceClaude, Workspace: "/workspace", SessionIDs: []string{"session-1"}, Confirmed: true})
	if err == nil || !strings.Contains(err.Error(), "T3 is running") {
		t.Fatalf("live-T3 refusal error = %v", err)
	}
	if source.loads != 0 || targetEventCount(t, paths.DBPath) != 0 {
		t.Fatalf("live T3 check occurred too late: loads=%d events=%d", source.loads, targetEventCount(t, paths.DBPath))
	}
}

func TestServiceExecuteDryRunImportThenSync(t *testing.T) {
	root := t.TempDir()
	t.Setenv("T3_IMPORT_DATA_DIR", filepath.Join(root, "ledger"))
	cacheRoot := filepath.Join(root, "t3-profile")
	cachePath := filepath.Join(cacheRoot, "IndexedDB", "t3code_app_0.indexeddb.leveldb")
	if err := os.MkdirAll(cachePath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cachePath, "CURRENT"), []byte("cache"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("T3_CODE_USER_DATA", cacheRoot)
	paths := makeLegacyTarget(t, filepath.Join(root, "state"))
	source := &fixedSource{conversation: sampleConversation()}
	service := &Service{Paths: paths, Sources: registry.NewWith(source)}
	noCacheReset := false
	request := Request{Action: "execute", Source: domain.SourceClaude, Workspace: source.conversation.Summary.Workspace, SessionIDs: []string{source.conversation.Summary.ID}, DryRun: true}

	dryRun, err := service.Call(context.Background(), request)
	if err != nil {
		t.Fatalf("unconfirmed dry run: %v", err)
	}
	var planned struct {
		Imported struct {
			Status  string `json:"status"`
			Backup  string `json:"backup"`
			Results []any  `json:"results"`
		} `json:"imported"`
	}
	if err := json.Unmarshal(dryRun, &planned); err != nil {
		t.Fatal(err)
	}
	if planned.Imported.Status != "dry-run" || planned.Imported.Backup != "" || len(planned.Imported.Results) != 1 {
		t.Fatalf("unexpected dry-run response: %s", dryRun)
	}
	if count := targetEventCount(t, paths.DBPath); count != 0 {
		t.Fatalf("dry run wrote %d target events", count)
	}
	if _, err := os.Stat(cachePath); err != nil {
		t.Fatalf("dry run changed the T3 cache: %v", err)
	}

	request.Confirmed = true
	request.DryRun = false
	imported, err := service.Call(context.Background(), request)
	if err != nil {
		t.Fatalf("confirmed import: %v", err)
	}
	var importResult struct {
		Imported struct {
			Status string `json:"status"`
			Backup string `json:"backup"`
			Cache  *struct {
				Status string `json:"status"`
				Backup string `json:"backup"`
			} `json:"cache"`
			Results []struct {
				Status   string `json:"status"`
				ThreadID string `json:"threadId"`
			} `json:"results"`
		} `json:"imported"`
	}
	if err := json.Unmarshal(imported, &importResult); err != nil {
		t.Fatal(err)
	}
	if importResult.Imported.Status != "imported" || importResult.Imported.Backup == "" || len(importResult.Imported.Results) != 1 || importResult.Imported.Results[0].Status != "imported" {
		t.Fatalf("unexpected import response: %s", imported)
	}
	if _, err := os.Stat(importResult.Imported.Backup); err != nil {
		t.Fatalf("verified pre-write backup missing: %v", err)
	}
	if importResult.Imported.Cache == nil || importResult.Imported.Cache.Status != "reset" || importResult.Imported.Cache.Backup == "" {
		t.Fatalf("default cache reset missing from result: %s", imported)
	}
	if _, err := os.Stat(cachePath); !os.IsNotExist(err) {
		t.Fatalf("cache reset left the original cache path: %v", err)
	}
	if _, err := os.Stat(filepath.Join(importResult.Imported.Cache.Backup, "t3-profile", "t3code_app_0.indexeddb.leveldb", "CURRENT")); err != nil {
		t.Fatalf("verified IndexedDB cache backup missing: %v", err)
	}
	if count := targetEventCount(t, paths.DBPath); count == 0 {
		t.Fatal("confirmed import wrote no target events")
	}

	updated := source.conversation
	updated.Fingerprint = "fingerprint-2"
	updated.Threads[0].Turns = append(updated.Threads[0].Turns, canonicalTurn("turn-2", "second question", "second answer"))
	source.conversation = updated
	request.ResetCache = &noCacheReset
	request.Mode = ModeSync
	synced, err := service.Call(context.Background(), request)
	if err != nil {
		t.Fatalf("sync appended source turn: %v", err)
	}
	var syncResult struct {
		Synced struct {
			Status  string `json:"status"`
			Backup  string `json:"backup"`
			Results []struct {
				Status     string `json:"status"`
				TurnsAdded int    `json:"turnsAdded"`
			} `json:"results"`
		} `json:"synced"`
	}
	if err := json.Unmarshal(synced, &syncResult); err != nil {
		t.Fatal(err)
	}
	if syncResult.Synced.Status != "synced" || syncResult.Synced.Backup == "" || len(syncResult.Synced.Results) != 1 || syncResult.Synced.Results[0].Status != "synced" || syncResult.Synced.Results[0].TurnsAdded != 1 {
		t.Fatalf("unexpected sync response: %s", synced)
	}
	oldThreadID := importResult.Imported.Results[0].ThreadID
	diverged := source.conversation
	diverged.Fingerprint = "fingerprint-3"
	diverged.Threads[0].Turns[0].Assistant[0].Text = "changed first answer"
	source.conversation = diverged
	request.Mode = ModeReplace
	preview, err := service.Call(context.Background(), Request{Action: "preview", Source: request.Source, Workspace: request.Workspace, Mode: ModeReplace, SessionIDs: request.SessionIDs})
	if err != nil {
		t.Fatalf("preview replacement: %v", err)
	}
	var replacementPreview struct {
		Sessions []struct {
			Replacement ReplacementPreview `json:"replacement"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(preview, &replacementPreview); err != nil || len(replacementPreview.Sessions) != 1 || !replacementPreview.Sessions[0].Replacement.Selectable {
		t.Fatalf("replacement should be selectable: %v (%s)", err, preview)
	}
	replaced, err := service.Call(context.Background(), request)
	if err != nil {
		t.Fatalf("replace divergent source history: %v", err)
	}
	var replaceResult struct {
		Replaced struct {
			Status  string `json:"status"`
			Backup  string `json:"backup"`
			Results []struct {
				Status      string `json:"status"`
				OldThreadID string `json:"oldThreadId"`
				NewThreadID string `json:"newThreadId"`
			} `json:"results"`
		} `json:"replaced"`
	}
	if err := json.Unmarshal(replaced, &replaceResult); err != nil {
		t.Fatal(err)
	}
	if replaceResult.Replaced.Status != "replaced" || replaceResult.Replaced.Backup == "" || len(replaceResult.Replaced.Results) != 1 || replaceResult.Replaced.Results[0].Status != "replaced" || replaceResult.Replaced.Results[0].OldThreadID != oldThreadID || replaceResult.Replaced.Results[0].NewThreadID == "" || replaceResult.Replaced.Results[0].NewThreadID == oldThreadID {
		t.Fatalf("unexpected replacement response: %s", replaced)
	}
	db, err := sqlite.Open(paths.DBPath, sqlite.Options{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	var deleted int
	err = db.QueryRow(`SELECT COUNT(*) FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? AND event_type='thread.deleted'`, oldThreadID).Scan(&deleted)
	_ = db.Close()
	if err != nil || deleted != 1 {
		t.Fatalf("old target thread was not tombstoned once: count=%d err=%v", deleted, err)
	}
}

func TestClaudeSyncMatchesLinearContinuationAfterLeafChanges(t *testing.T) {
	root := t.TempDir()
	t.Setenv("T3_IMPORT_DATA_DIR", filepath.Join(root, "ledger"))
	paths := makeV2Target(t, filepath.Join(root, "state"))
	conversation := sampleConversation()
	conversation.Threads[0].SourceKey = "claude:session-1:assistant-1"
	conversation.Threads[0].LeafID = stringPtr("assistant-1")
	conversation.Threads[0].ResumeCursor = map[string]any{"resume": "session-1", "resumeSessionAt": "assistant-1", "turnCount": 1}
	source := &fixedSource{conversation: conversation}
	service := &Service{Paths: paths, Sources: registry.NewWith(source)}
	noCacheReset := false
	request := Request{Action: "execute", Source: domain.SourceClaude, Workspace: conversation.Summary.Workspace, SessionIDs: []string{conversation.Summary.ID}, Confirmed: true, ResetCache: &noCacheReset}
	if _, err := service.Call(context.Background(), request); err != nil {
		t.Fatalf("initial Claude import: %v", err)
	}

	continued := conversation
	continued.Fingerprint = "claude-leaf-continuation"
	continued.Threads[0].SourceKey = "claude:session-1:assistant-2"
	continued.Threads[0].LeafID = stringPtr("assistant-2")
	continued.Threads[0].Turns = append(continued.Threads[0].Turns, canonicalTurn("turn-2", "second question", "second answer"))
	continued.Threads[0].ResumeCursor = map[string]any{"resume": "session-1", "resumeSessionAt": "assistant-2", "turnCount": 2}
	source.conversation = continued

	previewJSON, err := service.Call(context.Background(), Request{Action: "preview", Source: request.Source, Workspace: request.Workspace, Mode: ModeSync, SessionIDs: request.SessionIDs})
	if err != nil {
		t.Fatalf("Claude continuation preview: %v", err)
	}
	var preview struct {
		Sessions []PreviewSession `json:"sessions"`
	}
	if err := json.Unmarshal(previewJSON, &preview); err != nil || len(preview.Sessions) != 1 {
		t.Fatalf("Claude continuation preview response: %v (%s)", err, previewJSON)
	}
	if preview.Sessions[0].Sync.Status != "syncable" || preview.Sessions[0].Sync.NewTurns != 1 || !preview.Sessions[0].Sync.Selectable {
		t.Fatalf("linear Claude continuation was not recognized: %s", previewJSON)
	}

	request.Mode = ModeSync
	resultJSON, err := service.Call(context.Background(), request)
	if err != nil {
		t.Fatalf("Claude continuation sync: %v", err)
	}
	var result struct {
		Synced struct {
			Results []struct {
				Status     string `json:"status"`
				TurnsAdded int    `json:"turnsAdded"`
			} `json:"results"`
		} `json:"synced"`
	}
	if err := json.Unmarshal(resultJSON, &result); err != nil || len(result.Synced.Results) != 1 || result.Synced.Results[0].Status != "synced" || result.Synced.Results[0].TurnsAdded != 1 {
		t.Fatalf("Claude continuation sync response: %v (%s)", err, resultJSON)
	}

	postSyncJSON, err := service.Call(context.Background(), Request{Action: "preview", Source: request.Source, Workspace: request.Workspace, Mode: ModeSync, SessionIDs: request.SessionIDs})
	if err != nil {
		t.Fatalf("Claude repeat-sync preview: %v", err)
	}
	if err := json.Unmarshal(postSyncJSON, &preview); err != nil || len(preview.Sessions) != 1 || preview.Sessions[0].Sync.Status != "up-to-date" || preview.Sessions[0].Sync.NewTurns != 0 {
		t.Fatalf("Claude repeat-sync was not idempotent: %v (%s)", err, postSyncJSON)
	}

	diverged := continued
	diverged.Fingerprint = "claude-diverged-leaf"
	diverged.Threads[0].SourceKey = "claude:session-1:diverged-leaf"
	diverged.Threads[0].LeafID = stringPtr("diverged-leaf")
	diverged.Threads[0].Turns[0].Assistant[0].Text = "edited first answer"
	source.conversation = diverged
	divergedJSON, err := service.Call(context.Background(), Request{Action: "preview", Source: request.Source, Workspace: request.Workspace, Mode: ModeSync, SessionIDs: request.SessionIDs})
	if err != nil {
		t.Fatalf("Claude divergent-branch preview: %v", err)
	}
	if err := json.Unmarshal(divergedJSON, &preview); err != nil || len(preview.Sessions) != 1 || preview.Sessions[0].Sync.Status != "history-diverged" || preview.Sessions[0].Sync.Selectable {
		t.Fatalf("divergent Claude leaf was treated as a syncable continuation: %v (%s)", err, divergedJSON)
	}
}

func TestServiceV2ImportSyncAndReplacement(t *testing.T) {
	root := t.TempDir()
	t.Setenv("T3_IMPORT_DATA_DIR", filepath.Join(root, "ledger"))
	paths := makeV2Target(t, filepath.Join(root, "state"))
	source := &fixedSource{conversation: sampleConversation()}
	source.conversation.Threads[0].ResumeCursor = map[string]any{"resume": "session-1", "resumeSessionAt": "turn-1:assistant", "turnCount": 1}
	service := &Service{Paths: paths, Sources: registry.NewWith(source)}
	noCacheReset := false
	request := Request{Action: "execute", Source: domain.SourceClaude, Workspace: source.conversation.Summary.Workspace, SessionIDs: []string{source.conversation.Summary.ID}, Confirmed: true, ResetCache: &noCacheReset}
	initial, err := service.Call(context.Background(), request)
	if err != nil {
		t.Fatalf("v2 import: %v", err)
	}
	var imported struct {
		Imported struct {
			Status  string `json:"status"`
			Results []struct {
				ThreadID string `json:"threadId"`
			} `json:"results"`
		} `json:"imported"`
	}
	if err := json.Unmarshal(initial, &imported); err != nil || imported.Imported.Status != "imported" || len(imported.Imported.Results) != 1 {
		t.Fatalf("v2 import response: %v (%s)", err, initial)
	}
	oldID := imported.Imported.Results[0].ThreadID

	updated := source.conversation
	updated.Fingerprint = "v2-fingerprint-2"
	updated.Threads[0].Turns = append(updated.Threads[0].Turns, canonicalTurn("turn-2", "second question", "second answer"))
	updated.Threads[0].ResumeCursor = map[string]any{"resume": "session-1", "resumeSessionAt": "turn-2:assistant", "turnCount": 2}
	source.conversation = updated
	request.Mode = ModeSync
	previewResponse, err := service.Call(context.Background(), Request{Action: "preview", Source: request.Source, Workspace: request.Workspace, Mode: ModeSync, SessionIDs: request.SessionIDs})
	if err != nil {
		t.Fatalf("v2 sync preview: %v", err)
	}
	var syncPreview struct {
		Sessions []PreviewSession `json:"sessions"`
	}
	if err := json.Unmarshal(previewResponse, &syncPreview); err != nil || len(syncPreview.Sessions) != 1 || syncPreview.Sessions[0].Sync.Status != "syncable" {
		t.Fatalf("v2 sync preview: %v (%s)", err, previewResponse)
	}
	syncResponse, err := service.Call(context.Background(), request)
	if err != nil {
		t.Fatalf("v2 sync: %v", err)
	}
	var synced struct {
		Synced struct {
			Status  string `json:"status"`
			Results []struct {
				Status     string `json:"status"`
				TurnsAdded int    `json:"turnsAdded"`
			} `json:"results"`
		} `json:"synced"`
	}
	if err := json.Unmarshal(syncResponse, &synced); err != nil || synced.Synced.Status != "synced" || len(synced.Synced.Results) != 1 || synced.Synced.Results[0].TurnsAdded != 1 {
		t.Fatalf("v2 sync response: %v (%s)", err, syncResponse)
	}

	diverged := source.conversation
	diverged.Fingerprint = "v2-fingerprint-3"
	diverged.Threads[0].Turns[0].Assistant[0].Text = "changed first answer"
	source.conversation = diverged
	request.Mode = ModeReplace
	replacedResponse, err := service.Call(context.Background(), request)
	if err != nil {
		t.Fatalf("v2 replacement: %v", err)
	}
	var replaced struct {
		Replaced struct {
			Status  string `json:"status"`
			Results []struct {
				Status            string `json:"status"`
				OldThreadID       string `json:"oldThreadId"`
				NewThreadID       string `json:"newThreadId"`
				ResumeTransferred bool   `json:"resumeTransferred"`
			} `json:"results"`
		} `json:"replaced"`
	}
	if err := json.Unmarshal(replacedResponse, &replaced); err != nil || replaced.Replaced.Status != "replaced" || len(replaced.Replaced.Results) != 1 || replaced.Replaced.Results[0].Status != "replaced" || replaced.Replaced.Results[0].OldThreadID != oldID || replaced.Replaced.Results[0].NewThreadID == "" || replaced.Replaced.Results[0].NewThreadID == oldID || !replaced.Replaced.Results[0].ResumeTransferred {
		t.Fatalf("v2 replacement response: %v (%s)", err, replacedResponse)
	}
	ledgerPath, err := ledger.DefaultPath()
	if err != nil {
		t.Fatal(err)
	}
	ledgerDB, err := sqlite.Open(ledgerPath, sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ledgerDB.Exec(`DELETE FROM imports WHERE thread_id=?`, replaced.Replaced.Results[0].NewThreadID); err != nil {
		t.Fatal(err)
	}
	if _, err := ledgerDB.Exec(`UPDATE imports SET is_canonical=1,superseded_by_thread_id=NULL,replaced_at=NULL WHERE thread_id=?`, oldID); err != nil {
		t.Fatal(err)
	}
	_ = ledgerDB.Close()
	db, err := sqlite.Open(paths.DBPath, sqlite.Options{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	var deleted int
	err = db.QueryRow(`SELECT COUNT(*) FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? AND event_type='thread.deleted'`, oldID).Scan(&deleted)
	var runtimeThreadID, runtimeCursor string
	if err == nil {
		err = db.QueryRow(`SELECT thread_id,resume_cursor_json FROM provider_session_runtime WHERE thread_id=?`, replaced.Replaced.Results[0].NewThreadID).Scan(&runtimeThreadID, &runtimeCursor)
	}
	var cursor map[string]any
	if err == nil {
		err = json.Unmarshal([]byte(runtimeCursor), &cursor)
	}
	_ = db.Close()
	if err != nil || deleted != 1 || runtimeThreadID != replaced.Replaced.Results[0].NewThreadID || cursor["threadId"] != runtimeThreadID || cursor["resume"] != "session-1" {
		t.Fatalf("v2 replacement state deleted=%d runtimeThread=%q cursor=%s err=%v", deleted, runtimeThreadID, runtimeCursor, err)
	}

	continued := source.conversation
	continued.Fingerprint = "v2-fingerprint-4"
	continued.Threads[0].Turns = append(continued.Threads[0].Turns, canonicalTurn("turn-3", "third question", "third answer"))
	continued.Threads[0].ResumeCursor = map[string]any{"resume": "session-1", "resumeSessionAt": "turn-3:assistant", "turnCount": 3}
	source.conversation = continued
	request.Mode = ModeSync
	continuedPreview, err := service.Call(context.Background(), Request{Action: "preview", Source: request.Source, Workspace: request.Workspace, Mode: ModeSync, SessionIDs: request.SessionIDs})
	if err != nil {
		t.Fatalf("v2 sync after replacement preview: %v", err)
	}
	var afterReplacementPreview struct {
		Sessions []PreviewSession `json:"sessions"`
	}
	if err := json.Unmarshal(continuedPreview, &afterReplacementPreview); err != nil || len(afterReplacementPreview.Sessions) != 1 || afterReplacementPreview.Sessions[0].Sync.Status != "syncable" {
		t.Fatalf("v2 sync after replacement preview: %v (%s)", err, continuedPreview)
	}
	continuedResponse, err := service.Call(context.Background(), request)
	if err != nil {
		t.Fatalf("v2 sync after replacement: %v", err)
	}
	var continuedSync struct {
		Synced struct {
			Results []struct {
				Status     string `json:"status"`
				TurnsAdded int    `json:"turnsAdded"`
			} `json:"results"`
		} `json:"synced"`
	}
	if err := json.Unmarshal(continuedResponse, &continuedSync); err != nil || len(continuedSync.Synced.Results) != 1 || continuedSync.Synced.Results[0].Status != "synced" || continuedSync.Synced.Results[0].TurnsAdded != 1 {
		t.Fatalf("v2 sync after replacement response: %v (%s)", err, continuedResponse)
	}
	ledgerDB, err = sqlite.Open(ledgerPath, sqlite.Options{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	var oldCanonical, newCanonical int
	if err := ledgerDB.QueryRow(`SELECT is_canonical FROM imports WHERE thread_id=?`, oldID).Scan(&oldCanonical); err != nil {
		t.Fatal(err)
	}
	if err := ledgerDB.QueryRow(`SELECT is_canonical FROM imports WHERE thread_id=?`, replaced.Replaced.Results[0].NewThreadID).Scan(&newCanonical); err != nil {
		t.Fatal(err)
	}
	_ = ledgerDB.Close()
	if oldCanonical != 0 || newCanonical != 1 {
		t.Fatalf("replacement ledger recovery left ambiguous ownership: old=%d new=%d", oldCanonical, newCanonical)
	}
}

func TestServiceAdoptsExactBuiltinV2ImportWithoutReplayingHistory(t *testing.T) {
	root := t.TempDir()
	t.Setenv("T3_IMPORT_DATA_DIR", filepath.Join(root, "ledger"))
	paths := makeV2Target(t, filepath.Join(root, "state"))
	conversation := sampleConversation()
	conversation.Summary.Source = domain.SourceCodex
	conversation.Summary.ID = "native-codex-session"
	conversation.Summary.Title = "Imported by T3"
	conversation.Threads[0].Source = domain.SourceCodex
	conversation.Threads[0].SourceSessionID = conversation.Summary.ID
	conversation.Threads[0].SourceKey = "codex:" + conversation.Summary.ID
	conversation.Threads[0].Title = conversation.Summary.Title
	conversation.Threads[0].Model = "gpt-test"
	conversation.Threads[0].ResumeCursor = map[string]any{"threadId": conversation.Summary.ID}
	threadID := "import:codex:" + conversation.Summary.ID
	projectID := "project-built-in"
	db, err := sqlite.Open(paths.DBPath, sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at,deleted_at,default_model_selection_json) VALUES(?,?,?,?,?,?,NULL,?)`, projectID, "Workspace", conversation.Summary.Workspace, "[]", conversation.Summary.CreatedAt, conversation.Summary.UpdatedAt, "{}"); err != nil {
		t.Fatal(err)
	}
	plan, err := v2.BuildPlanWithRuntimeOptions(conversation.Threads[0], threadID, projectID, "codex", conversation.Threads[0].Model, map[string]any{}, false, paths.AttachmentsDir, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = v2.AppendPlan(context.Background(), db, plan); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	eventsBefore := targetEventCount(t, paths.DBPath)
	service := &Service{Paths: paths, Sources: registry.NewWith(&fixedSource{conversation: conversation})}
	reset := false
	response, err := service.Call(context.Background(), Request{Action: "execute", Source: domain.SourceCodex, Workspace: conversation.Summary.Workspace, SessionIDs: []string{conversation.Summary.ID}, Confirmed: true, ResetCache: &reset})
	if err != nil {
		t.Fatalf("adopt built-in import: %v", err)
	}
	var result struct {
		Imported struct {
			Results []struct {
				Status   string `json:"status"`
				ThreadID string `json:"threadId"`
			} `json:"results"`
		} `json:"imported"`
	}
	if err := json.Unmarshal(response, &result); err != nil || len(result.Imported.Results) != 1 || result.Imported.Results[0].Status != "adopted" || result.Imported.Results[0].ThreadID != threadID {
		t.Fatalf("unexpected built-in adoption response: %v (%s)", err, response)
	}
	if after := targetEventCount(t, paths.DBPath); after != eventsBefore {
		t.Fatalf("built-in history was replayed: events before=%d after=%d", eventsBefore, after)
	}
	store, err := ledger.Open(filepath.Join(root, "ledger", "ledger.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	records, err := store.List(context.Background(), identity.TargetID(paths.DBPath), domain.SourceCodex)
	if err != nil || len(records) != 1 || records[0].ThreadID != threadID || records[0].ProjectID != projectID {
		t.Fatalf("built-in adoption ledger mapping: records=%+v err=%v", records, err)
	}
}

func TestServiceAdoptsNativeV2ContinuationAndCheckpointsItOnce(t *testing.T) {
	root := t.TempDir()
	t.Setenv("T3_IMPORT_DATA_DIR", filepath.Join(root, "ledger"))
	paths := makeV2Target(t, filepath.Join(root, "state"))
	conversation := sampleConversation()
	conversation.Summary.Source = domain.SourceCodex
	conversation.Summary.ID = "native-sync-session"
	conversation.Summary.Title = "Imported by T3"
	conversation.Threads[0].Source = domain.SourceCodex
	conversation.Threads[0].SourceSessionID = conversation.Summary.ID
	conversation.Threads[0].SourceKey = "codex:" + conversation.Summary.ID
	conversation.Threads[0].Title = conversation.Summary.Title
	conversation.Threads[0].Model = "gpt-test"
	conversation.Threads[0].ResumeCursor = map[string]any{"threadId": conversation.Summary.ID}
	threadID, projectID := "import:codex:"+conversation.Summary.ID, "project-native-sync"
	db, err := sqlite.Open(paths.DBPath, sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at,deleted_at,default_model_selection_json) VALUES(?,?,?,?,?,?,NULL,?)`, projectID, "Workspace", conversation.Summary.Workspace, "[]", conversation.Summary.CreatedAt, conversation.Summary.UpdatedAt, "{}"); err != nil {
		t.Fatal(err)
	}
	plan, err := v2.BuildPlanWithRuntimeOptions(conversation.Threads[0], threadID, projectID, "codex", conversation.Threads[0].Model, map[string]any{}, false, paths.AttachmentsDir, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = v2.AppendPlan(context.Background(), db, plan); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	serviceSource := &fixedSource{conversation: conversation}
	service := &Service{Paths: paths, Sources: registry.NewWith(serviceSource)}
	noCacheReset := false
	request := Request{Action: "execute", Source: domain.SourceCodex, Workspace: conversation.Summary.Workspace, SessionIDs: []string{conversation.Summary.ID}, Confirmed: true, ResetCache: &noCacheReset}
	if _, err = service.Call(context.Background(), request); err != nil {
		t.Fatalf("adopt built-in task: %v", err)
	}

	advanced := conversation
	advanced.Threads = append([]domain.CanonicalThread(nil), conversation.Threads...)
	advanced.Threads[0].Turns = append(append([]domain.CanonicalTurn(nil), conversation.Threads[0].Turns...), canonicalTurn("native-turn-2", "continue", "native answer"))
	advanced.Threads[0].Turns[1].Activities = []domain.CanonicalActivity{{
		SourceID: "native-usage-2", Timestamp: "2026-01-01T00:00:02.000Z", Tone: domain.ToneInfo,
		Kind: "context-window.updated", Summary: "Context window updated", Payload: map[string]any{"usedTokens": 42, "outputTokens": 7},
	}}
	advanced.Threads[0].UpdatedAt = "2026-01-02T00:00:02.000Z"
	advanced.Summary.UpdatedAt = advanced.Threads[0].UpdatedAt
	advanced.Fingerprint = "native-sync-fingerprint"
	serviceSource.conversation = advanced

	db, err = sqlite.Open(paths.DBPath, sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	projection, err := v2.InspectBuiltinProjection(context.Background(), db, threadID)
	if err != nil {
		t.Fatal(err)
	}
	providerID := projection.ProviderThreads[0]["id"].(string)
	providerTurnID := "native-provider-turn-2"
	providerTurnPayload, _ := json.Marshal(map[string]any{
		"id": providerTurnID, "providerThreadId": providerID, "nodeId": "native-node-2", "runAttemptId": "native-attempt-2",
		"nativeTurnRef": map[string]any{"driver": "codex", "nativeId": "native-turn-2", "strength": "strong"},
		"ordinal":       2, "status": "completed", "startedAt": "2026-01-01T00:00:00.000Z", "completedAt": "2026-01-01T00:00:02.000Z",
	})
	var nextSequence, nextVersion int64
	if err = db.QueryRow(`SELECT COALESCE(MAX(sequence),0)+1 FROM orchestration_events`).Scan(&nextSequence); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(`SELECT COALESCE(MAX(stream_version),-1)+1 FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=?`, threadID).Scan(&nextVersion); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json,application_event_version) VALUES(?,?,'thread',?,?,?,?,NULL,NULL,NULL,'server',?,'{}',2)`, nextSequence, "native-provider-turn-event-2", threadID, nextVersion, "provider-turn.updated", "2026-01-01T00:00:02.000Z", string(providerTurnPayload)); err != nil {
		t.Fatal(err)
	}
	checkpointID, scopeID, runID, attemptID, nodeID := "native-checkpoint-2", "native-checkpoint-scope-2", "native-run-2", "native-attempt-2", "native-node-2"
	checkpointItem := map[string]any{"id": "native-checkpoint-item-2", "threadId": threadID, "runId": runID, "nodeId": nodeID, "providerThreadId": providerID, "providerTurnId": nil, "nativeItemRef": nil, "parentItemId": nil, "ordinal": 999, "status": "completed", "type": "checkpoint", "checkpointId": checkpointID, "scopeId": scopeID, "files": []any{}}
	checkpointPayload, _ := json.Marshal(checkpointItem)
	if _, err = db.Exec(`INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json,application_event_version) VALUES(?,?,'thread',?,?,?,?,NULL,NULL,NULL,'server',?,'{}',2)`, nextSequence+1, "native-checkpoint-event-2", threadID, nextVersion+1, "turn-item.updated", "2026-01-01T00:00:02.000Z", string(checkpointPayload)); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,parent_item_id,ordinal,type,status,updated_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, checkpointItem["id"], threadID, runID, nodeID, providerID, nil, nil, 999, "checkpoint", "completed", "2026-01-01T00:00:02.000Z", string(checkpointPayload)); err != nil {
		t.Fatal(err)
	}
	for table, row := range map[string]map[string]any{
		"orchestration_v2_projection_runs":              {"id": runID, "threadId": threadID, "status": "completed", "providerInstanceId": "codex", "providerThreadId": providerID, "rootNodeId": nodeID, "checkpointId": checkpointID, "ordinal": 2, "activeAttemptId": attemptID, "userMessageId": "native-user-message-2"},
		"orchestration_v2_projection_run_attempts":      {"id": attemptID, "threadId": threadID, "runId": runID, "status": "completed", "rootNodeId": nodeID, "providerInstanceId": "codex", "providerThreadId": providerID, "providerTurnId": providerTurnID},
		"orchestration_v2_projection_nodes":             {"id": nodeID, "threadId": threadID, "runId": runID, "kind": "root_turn", "status": "completed", "providerThreadId": providerID, "checkpointScopeId": scopeID, "providerTurnId": providerTurnID},
		"orchestration_v2_projection_checkpoints":       {"id": checkpointID, "threadId": threadID, "scopeId": scopeID, "runId": runID, "nodeId": nodeID, "status": "missing", "appRunOrdinal": 2, "files": []any{}},
		"orchestration_v2_projection_checkpoint_scopes": {"id": scopeID, "threadId": threadID, "runId": runID, "nodeId": nodeID, "providerThreadId": providerID, "kind": "root_run", "advancesAppRunCount": true},
	} {
		encoded, marshalErr := json.Marshal(row)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		if _, err = db.Exec(`INSERT INTO `+table+`(thread_id,payload_json) VALUES(?,?)`, threadID, string(encoded)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = db.Exec(`UPDATE orchestration_v2_projection_metadata SET last_sequence=? WHERE projection_name='thread-projections'`, nextSequence+1); err != nil {
		t.Fatal(err)
	}
	fullPlan, err := v2.BuildPlanWithRuntimeOptions(advanced.Threads[0], threadID, projectID, "codex", advanced.Threads[0].Model, map[string]any{}, false, paths.AttachmentsDir, true)
	if err != nil {
		t.Fatal(err)
	}
	nativeEvents, err := v2.NativeSyncEvents(advanced.Threads[0], advanced.Threads[0].SourceKey, fullPlan, 1, paths.AttachmentsDir)
	if err != nil {
		t.Fatal(err)
	}
	withoutNativeUsage := nativeEvents[:0]
	for _, event := range nativeEvents {
		if event.Type == "turn-item.updated" && eventPayloadForTest(t, event)["type"] == "system_notice" {
			continue
		}
		withoutNativeUsage = append(withoutNativeUsage, event)
	}
	nativeEvents = withoutNativeUsage
	messageIDs := map[string]string{}
	for _, event := range nativeEvents {
		if event.Type != "message.updated" {
			continue
		}
		var payload map[string]any
		if err = json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		oldID := payload["id"].(string)
		messageIDs[oldID] = "native-" + oldID
	}
	for index := range nativeEvents {
		event := &nativeEvents[index]
		var payload map[string]any
		if err = json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		switch event.Type {
		case "message.updated":
			payload["id"] = messageIDs[payload["id"].(string)]
		case "turn-item.updated":
			payload["id"] = "native-" + payload["id"].(string)
			payload["messageId"] = messageIDs[payload["messageId"].(string)]
			payload["providerThreadId"] = providerID
			if payload["type"] == "assistant_message" {
				payload["providerTurnId"] = providerTurnID
				payload["nativeItemRef"] = map[string]any{"driver": "codex", "nativeId": advanced.Threads[0].Turns[1].Assistant[0].SourceID, "strength": "strong"}
			} else {
				payload["nativeItemRef"] = map[string]any{"driver": "codex", "nativeId": advanced.Threads[0].Turns[1].User.SourceID, "strength": "strong"}
			}
		}
		event.ID = "native-event:" + event.ID
		event.Payload, _ = json.Marshal(payload)
	}
	expected, err := v2.Read(context.Background(), db, threadID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = v2.AppendSync(context.Background(), db, v2.SyncPlan{ThreadID: threadID, ProjectID: projectID, ProviderInstanceID: "codex", Expected: expected, Events: nativeEvents}); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	preview, err := service.Call(context.Background(), Request{Action: "preview", Source: domain.SourceCodex, Workspace: advanced.Summary.Workspace, Mode: ModeSync, SessionIDs: []string{advanced.Summary.ID}})
	if err != nil {
		t.Fatalf("preview native continuation: %v", err)
	}
	var previewResult struct {
		Sessions []struct {
			Sync SyncPreview `json:"sync"`
		} `json:"sessions"`
	}
	if err = json.Unmarshal(preview, &previewResult); err != nil || len(previewResult.Sessions) != 1 || previewResult.Sessions[0].Sync.Status != "syncable" || previewResult.Sessions[0].Sync.NewTurns != 0 || previewResult.Sessions[0].Sync.AdoptedTurns != 1 {
		t.Fatalf("native continuation preview did not report safe adoption: err=%v response=%s", err, preview)
	}

	before := targetEventCount(t, paths.DBPath)
	request.Mode = ModeSync
	response, err := service.Call(context.Background(), request)
	if err != nil {
		t.Fatalf("sync native continuation: %v", err)
	}
	var result struct {
		Synced struct {
			Status  string `json:"status"`
			Results []struct {
				Status       string `json:"status"`
				TurnsAdded   int    `json:"turnsAdded"`
				TurnsAdopted int    `json:"turnsAdopted"`
				Events       int    `json:"events"`
			} `json:"results"`
		} `json:"synced"`
	}
	if err = json.Unmarshal(response, &result); err != nil || result.Synced.Status != "synced" || len(result.Synced.Results) != 1 || result.Synced.Results[0].TurnsAdded != 0 || result.Synced.Results[0].TurnsAdopted != 1 {
		t.Fatalf("native continuation result was not checkpointed: err=%v response=%s", err, response)
	}
	if after := targetEventCount(t, paths.DBPath); after != before+1 {
		t.Fatalf("source usage notice was not appended exactly once: events before=%d after=%d result=%+v response=%s", before, after, result.Synced.Results, response)
	}
	store, err := ledger.Open(filepath.Join(root, "ledger", "ledger.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	records, err := store.List(context.Background(), identity.TargetID(paths.DBPath), domain.SourceCodex)
	_ = store.Close()
	if err != nil || len(records) != 1 {
		t.Fatalf("native continuation ledger: records=%+v err=%v", records, err)
	}
	saved, valid := checkpoint.Parse(string(records[0].Checkpoint))
	if !valid || saved.Version != 2 || len(saved.V2.Turns) != 2 || saved.V2.NativeProjection == nil || len(*saved.V2.NativeProjection.ProviderTurns) != 1 || len(saved.V2.NativeProjection.TurnItems) != 5 {
		t.Fatalf("native continuation checkpoint was not advanced: %+v", saved)
	}
	secondPreview, err := service.Call(context.Background(), Request{Action: "preview", Source: domain.SourceCodex, Workspace: advanced.Summary.Workspace, Mode: ModeSync, SessionIDs: []string{advanced.Summary.ID}})
	if err != nil {
		t.Fatalf("preview after native sync: %v", err)
	}
	var second struct {
		Sessions []struct {
			Sync SyncPreview `json:"sync"`
		} `json:"sessions"`
	}
	if err = json.Unmarshal(secondPreview, &second); err != nil || len(second.Sessions) != 1 || second.Sessions[0].Sync.Status != "up-to-date" || second.Sessions[0].Sync.AdoptedTurns != 0 {
		t.Fatalf("native continuation was not idempotent: err=%v response=%s", err, secondPreview)
	}

	withSourceSuffix := advanced
	withSourceSuffix.Threads = append([]domain.CanonicalThread(nil), advanced.Threads...)
	withSourceSuffix.Threads[0].Turns = append(append([]domain.CanonicalTurn(nil), advanced.Threads[0].Turns...), canonicalTurn("source-turn-3", "later source question", "later source answer"))
	withSourceSuffix.Threads[0].UpdatedAt = "2026-01-03T00:00:02.000Z"
	withSourceSuffix.Summary.UpdatedAt = withSourceSuffix.Threads[0].UpdatedAt
	withSourceSuffix.Fingerprint = "native-sync-fingerprint-3"
	serviceSource.conversation = withSourceSuffix
	thirdPreview, err := service.Call(context.Background(), Request{Action: "preview", Source: domain.SourceCodex, Workspace: withSourceSuffix.Summary.Workspace, Mode: ModeSync, SessionIDs: []string{withSourceSuffix.Summary.ID}})
	if err != nil {
		t.Fatalf("preview source suffix after native continuation: %v", err)
	}
	var thirdPlan struct {
		Sessions []struct {
			Sync SyncPreview `json:"sync"`
		} `json:"sessions"`
	}
	if err = json.Unmarshal(thirdPreview, &thirdPlan); err != nil || len(thirdPlan.Sessions) != 1 || thirdPlan.Sessions[0].Sync.NewTurns != 1 || thirdPlan.Sessions[0].Sync.AdoptedTurns != 0 {
		t.Fatalf("source suffix after native continuation was misclassified: err=%v response=%s", err, thirdPreview)
	}
	beforeThirdSync := targetEventCount(t, paths.DBPath)
	serviceSource.conversation = withSourceSuffix
	response, err = service.Call(context.Background(), request)
	if err != nil {
		t.Fatalf("sync source suffix after native continuation: %v", err)
	}
	var thirdResult struct {
		Synced struct {
			Status  string `json:"status"`
			Results []struct {
				TurnsAdded   int `json:"turnsAdded"`
				TurnsAdopted int `json:"turnsAdopted"`
			} `json:"results"`
		} `json:"synced"`
	}
	if err = json.Unmarshal(response, &thirdResult); err != nil || thirdResult.Synced.Status != "synced" || len(thirdResult.Synced.Results) != 1 || thirdResult.Synced.Results[0].TurnsAdded != 1 || thirdResult.Synced.Results[0].TurnsAdopted != 0 {
		t.Fatalf("source suffix after native continuation was not appended: err=%v response=%s", err, response)
	}
	if after := targetEventCount(t, paths.DBPath); after != beforeThirdSync+4 {
		t.Fatalf("native checkpoint append wrote the wrong event count: before=%d after=%d", beforeThirdSync, after)
	}
	db, err = sqlite.Open(paths.DBPath, sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	var checkpointRowJSON string
	if err = db.QueryRow(`SELECT payload_json FROM orchestration_v2_projection_checkpoints WHERE thread_id=?`, threadID).Scan(&checkpointRowJSON); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	var checkpointRow map[string]any
	if err = json.Unmarshal([]byte(checkpointRowJSON), &checkpointRow); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	checkpointRow["runId"] = "foreign-run"
	checkpointRowBytes, _ := json.Marshal(checkpointRow)
	if _, err = db.Exec(`UPDATE orchestration_v2_projection_checkpoints SET payload_json=? WHERE thread_id=?`, string(checkpointRowBytes), threadID); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	_ = db.Close()
	beforeRejected := targetEventCount(t, paths.DBPath)
	rejectedPreview, err := service.Call(context.Background(), Request{Action: "preview", Source: domain.SourceCodex, Workspace: withSourceSuffix.Summary.Workspace, Mode: ModeSync, SessionIDs: []string{withSourceSuffix.Summary.ID}})
	if err != nil {
		t.Fatalf("preview foreign checkpoint provenance: %v", err)
	}
	var rejected struct {
		Sessions []struct {
			Sync SyncPreview `json:"sync"`
		} `json:"sessions"`
	}
	if err = json.Unmarshal(rejectedPreview, &rejected); err != nil || len(rejected.Sessions) != 1 || rejected.Sessions[0].Sync.Status != "history-diverged" {
		t.Fatalf("foreign checkpoint provenance was accepted: err=%v response=%s", err, rejectedPreview)
	}
	if after := targetEventCount(t, paths.DBPath); after != beforeRejected {
		t.Fatalf("rejected checkpoint sync mutated T3: before=%d after=%d", beforeRejected, after)
	}
}

func TestServiceRecoversV2CheckpointAfterTargetCommit(t *testing.T) {
	root := t.TempDir()
	ledgerPath := filepath.Join(root, "ledger")
	t.Setenv("T3_IMPORT_DATA_DIR", ledgerPath)
	paths := makeV2Target(t, filepath.Join(root, "state"))
	conversation := sampleConversation()
	conversation.Summary.Source = domain.SourceCodex
	conversation.Summary.ID = "interrupted-sync-session"
	conversation.Threads[0].Source = domain.SourceCodex
	conversation.Threads[0].SourceSessionID = conversation.Summary.ID
	conversation.Threads[0].SourceKey = "codex:" + conversation.Summary.ID
	conversation.Threads[0].ResumeCursor = map[string]any{"threadId": conversation.Summary.ID}
	source := &fixedSource{conversation: conversation}
	service := &Service{Paths: paths, Sources: registry.NewWith(source)}
	noCacheReset := false
	request := Request{Action: "execute", Source: domain.SourceCodex, Workspace: conversation.Summary.Workspace, SessionIDs: []string{conversation.Summary.ID}, Confirmed: true, ResetCache: &noCacheReset}
	if _, err := service.Call(context.Background(), request); err != nil {
		t.Fatalf("initial import: %v", err)
	}

	store, err := ledger.Open(filepath.Join(ledgerPath, "ledger.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	records, err := store.List(context.Background(), identity.TargetID(paths.DBPath), domain.SourceCodex)
	_ = store.Close()
	if err != nil || len(records) != 1 {
		t.Fatalf("initial import ledger: records=%+v err=%v", records, err)
	}
	record := records[0]
	advanced := conversation
	advanced.Threads = append([]domain.CanonicalThread(nil), conversation.Threads...)
	advanced.Threads[0].Turns = append(append([]domain.CanonicalTurn(nil), conversation.Threads[0].Turns...), canonicalTurn("interrupted-turn-2", "follow up", "follow up answer"))
	advanced.Threads[0].UpdatedAt = "2026-01-02T00:00:02.000Z"
	advanced.Summary.UpdatedAt = advanced.Threads[0].UpdatedAt
	advanced.Fingerprint = "interrupted-sync-fingerprint"

	// Simulate a process that committed the source suffix to T3 and stopped
	// before it could advance the importer ledger checkpoint.
	db, err := sqlite.Open(paths.DBPath, sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	existing, err := v2.InspectThread(context.Background(), db, record.ThreadID)
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	fullPlan, err := v2.BuildPlanWithRuntimeOptions(advanced.Threads[0], record.ThreadID, record.ProjectID, "codex", advanced.Threads[0].Model, map[string]any{}, false, paths.AttachmentsDir, true)
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	suffixEvents, err := v2.NativeSyncEvents(advanced.Threads[0], record.IdentitySeed, fullPlan, len(conversation.Threads[0].Turns), paths.AttachmentsDir)
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	if len(suffixEvents) == 0 {
		_ = db.Close()
		t.Fatal("simulation did not create a target suffix")
	}
	syncPlan := v2.SyncPlan{ThreadID: record.ThreadID, ProjectID: record.ProjectID, ProviderInstanceID: fullPlan.ProviderInstanceID, Expected: existing, Events: suffixEvents, Runtime: fullPlan.Runtime}
	if _, err = v2.AppendSync(context.Background(), db, syncPlan); err != nil {
		_ = db.Close()
		t.Fatalf("commit target suffix: %v", err)
	}
	_ = db.Close()
	source.conversation = advanced

	preview, err := service.Call(context.Background(), Request{Action: "preview", Source: domain.SourceCodex, Workspace: advanced.Summary.Workspace, Mode: ModeSync, SessionIDs: []string{advanced.Summary.ID}})
	if err != nil {
		t.Fatalf("preview stale checkpoint: %v", err)
	}
	var previewResult struct {
		Sessions []struct {
			Sync SyncPreview `json:"sync"`
		} `json:"sessions"`
	}
	if err = json.Unmarshal(preview, &previewResult); err != nil || len(previewResult.Sessions) != 1 || previewResult.Sessions[0].Sync.Status != "syncable" || previewResult.Sessions[0].Sync.NewTurns != 1 {
		t.Fatalf("stale checkpoint was not offered for reconciliation: err=%v response=%s", err, preview)
	}
	before := targetEventCount(t, paths.DBPath)
	request.Mode = ModeSync
	response, err := service.Call(context.Background(), request)
	if err != nil {
		t.Fatalf("advance stale checkpoint: %v", err)
	}
	var result struct {
		Synced struct {
			Status  string `json:"status"`
			Results []struct {
				TurnsAdded int `json:"turnsAdded"`
				Events     int `json:"events"`
			} `json:"results"`
		} `json:"synced"`
	}
	if err = json.Unmarshal(response, &result); err != nil || result.Synced.Status != "synced" || len(result.Synced.Results) != 1 || result.Synced.Results[0].TurnsAdded != 1 || result.Synced.Results[0].Events != 0 {
		t.Fatalf("stale checkpoint was not reconciled without replay: err=%v response=%s", err, response)
	}
	if after := targetEventCount(t, paths.DBPath); after != before {
		t.Fatalf("checkpoint recovery replayed already committed T3 events: before=%d after=%d", before, after)
	}
	store, err = ledger.Open(filepath.Join(ledgerPath, "ledger.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	records, err = store.List(context.Background(), identity.TargetID(paths.DBPath), domain.SourceCodex)
	_ = store.Close()
	if err != nil || len(records) != 1 {
		t.Fatalf("reconciled ledger: records=%+v err=%v", records, err)
	}
	saved, valid := checkpoint.Parse(string(records[0].Checkpoint))
	if !valid || saved.Version != 2 || len(saved.V2.Turns) != 2 || saved.V2.NativeProjection == nil {
		t.Fatalf("target-committed checkpoint was not advanced with projection identity: %+v", saved)
	}
	secondPreview, err := service.Call(context.Background(), Request{Action: "preview", Source: domain.SourceCodex, Workspace: advanced.Summary.Workspace, Mode: ModeSync, SessionIDs: []string{advanced.Summary.ID}})
	if err != nil {
		t.Fatalf("preview after checkpoint recovery: %v", err)
	}
	if err = json.Unmarshal(secondPreview, &previewResult); err != nil || len(previewResult.Sessions) != 1 || previewResult.Sessions[0].Sync.Status != "up-to-date" {
		t.Fatalf("checkpoint recovery was not idempotent: err=%v response=%s", err, secondPreview)
	}
}

func TestServiceReconcilesPreUpgradeV2LedgerWithoutReplayingHistory(t *testing.T) {
	root := t.TempDir()
	ledgerPath := filepath.Join(root, "ledger")
	t.Setenv("T3_IMPORT_DATA_DIR", ledgerPath)
	paths := makeV2Target(t, filepath.Join(root, "state"))
	conversation := sampleConversation()
	conversation.Summary.Source = domain.SourceCodex
	conversation.Summary.ID = "pre-upgrade-codex-session"
	conversation.Threads[0].Source = domain.SourceCodex
	conversation.Threads[0].SourceSessionID = conversation.Summary.ID
	conversation.Threads[0].SourceKey = "codex:" + conversation.Summary.ID
	conversation.Threads[0].ResumeCursor = map[string]any{"threadId": conversation.Summary.ID}
	threadID := identity.ThreadID(conversation.Threads[0].SourceKey, conversation.Summary.ID, false)
	projectID := "project-pre-upgrade"
	db, err := sqlite.Open(paths.DBPath, sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at,deleted_at,default_model_selection_json) VALUES(?,?,?,?,?,?,NULL,?)`, projectID, "Workspace", conversation.Summary.Workspace, "[]", conversation.Summary.CreatedAt, conversation.Summary.UpdatedAt, "{}"); err != nil {
		t.Fatal(err)
	}
	fullPlan, err := v2.BuildPlanWithRuntimeOptions(conversation.Threads[0], threadID, projectID, "codex", conversation.Threads[0].Model, map[string]any{}, false, paths.AttachmentsDir, true)
	if err != nil {
		t.Fatal(err)
	}
	converted := fullPlan
	converted.Runtime = nil
	converted.Events = nil
	for _, event := range fullPlan.Events {
		if event.Type == "provider-thread.updated" {
			continue
		}
		if event.Type == "thread.created" {
			var payload map[string]any
			if err = json.Unmarshal(event.Payload, &payload); err != nil {
				t.Fatal(err)
			}
			payload["activeProviderThreadId"] = nil
			event.Payload, _ = json.Marshal(payload)
		}
		converted.Events = append(converted.Events, event)
	}
	if _, err = v2.AppendPlan(context.Background(), db, converted); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	savedCheckpoint, err := checkpoint.ForThread(conversation.Threads[0])
	if err != nil {
		t.Fatal(err)
	}
	checkpointJSON, _ := json.Marshal(savedCheckpoint)
	oldTargetID := identity.TargetID(filepath.Join(paths.StateDir, "state.sqlite"))
	oldBackup := filepath.Join(root, "legacy-backup.sqlite")
	oldRecord := ledger.Record{
		TargetID: oldTargetID, Source: domain.SourceCodex, SourceSessionID: conversation.Summary.ID,
		SourceKey: conversation.Threads[0].SourceKey, CurrentSourceKey: conversation.Threads[0].SourceKey,
		SourceFingerprint: conversation.Fingerprint, ProjectID: projectID, ThreadID: threadID,
		ImportedAt: "2026-01-02T00:00:00.000Z", ImporterVersion: "0.3.0", Migration: 52,
		FirstSequence: 1, LastSequence: int64(len(converted.Events)), Resumable: true, BackupPath: oldBackup,
		Warnings: []string{}, IdentitySeed: conversation.Threads[0].SourceKey, SourceTitle: conversation.Threads[0].Title,
		Checkpoint: checkpointJSON, IsCanonical: boolPointer(true),
	}
	store, err := ledger.Open(filepath.Join(ledgerPath, "ledger.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if err = store.RecordImports(context.Background(), []ledger.Record{oldRecord}); err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	_ = store.Close()

	advanced := conversation
	advanced.Threads = append([]domain.CanonicalThread(nil), conversation.Threads...)
	advanced.Threads[0].Turns = append(append([]domain.CanonicalTurn(nil), conversation.Threads[0].Turns...), canonicalTurn("post-upgrade-turn", "follow up", "follow up answer"))
	advanced.Threads[0].UpdatedAt = "2026-01-02T00:00:02.000Z"
	advanced.Summary.UpdatedAt = advanced.Threads[0].UpdatedAt
	advanced.Fingerprint = "post-upgrade-fingerprint"
	service := &Service{Paths: paths, Sources: registry.NewWith(&fixedSource{conversation: advanced})}
	preview, err := service.Call(context.Background(), Request{Action: "preview", Source: domain.SourceCodex, Workspace: advanced.Summary.Workspace, SessionIDs: []string{advanced.Summary.ID}})
	if err != nil {
		t.Fatalf("preview converted task: %v", err)
	}
	var previewResult struct {
		Sessions []struct {
			Sync SyncPreview `json:"sync"`
		} `json:"sessions"`
	}
	if err = json.Unmarshal(preview, &previewResult); err != nil || len(previewResult.Sessions) != 1 || previewResult.Sessions[0].Sync.Status != "syncable" || previewResult.Sessions[0].Sync.NewTurns != 1 {
		t.Fatalf("converted task was not offered for safe reconciliation: err=%v response=%s", err, preview)
	}
	before := targetEventCount(t, paths.DBPath)
	noCacheReset := false
	response, err := service.Call(context.Background(), Request{Action: "execute", Source: domain.SourceCodex, Workspace: advanced.Summary.Workspace, SessionIDs: []string{advanced.Summary.ID}, Confirmed: true, ResetCache: &noCacheReset})
	if err != nil {
		t.Fatalf("reconcile converted task: %v", err)
	}
	var result struct {
		Synced struct {
			Status  string `json:"status"`
			Results []struct {
				Status     string `json:"status"`
				Events     int    `json:"events"`
				TurnsAdded int    `json:"turnsAdded"`
			} `json:"results"`
		} `json:"synced"`
	}
	if err = json.Unmarshal(response, &result); err != nil || result.Synced.Status != "synced" || len(result.Synced.Results) != 1 || result.Synced.Results[0].Events != 5 || result.Synced.Results[0].TurnsAdded != 1 {
		t.Fatalf("converted task was not safely attached: err=%v response=%s", err, response)
	}
	if after := targetEventCount(t, paths.DBPath); after != before+5 {
		t.Fatalf("converted transcript was replayed or its source suffix was missed: before=%d after=%d", before, after)
	}
	db, err = sqlite.Open(paths.DBPath, sqlite.Options{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	projection, err := v2.InspectBuiltinProjection(context.Background(), db, threadID)
	_ = db.Close()
	if err != nil || len(projection.ProviderThreads) != 1 || projection.Thread["activeProviderThreadId"] != projection.ProviderThreads[0]["id"] {
		t.Fatalf("converted task provider binding was not projected: thread=%v providers=%v err=%v", projection.Thread, projection.ProviderThreads, err)
	}
	store, err = ledger.Open(filepath.Join(ledgerPath, "ledger.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	currentRows, currentErr := store.List(context.Background(), identity.TargetID(paths.DBPath), domain.SourceCodex)
	oldRows, oldErr := store.List(context.Background(), oldTargetID, domain.SourceCodex)
	_ = store.Close()
	if currentErr != nil || oldErr != nil || len(currentRows) != 1 || len(oldRows) != 1 || currentRows[0].BackupPath != oldBackup {
		t.Fatalf("current/retained mappings current=%+v old=%+v currentErr=%v oldErr=%v", currentRows, oldRows, currentErr, oldErr)
	}
	stored, valid := checkpoint.Parse(string(currentRows[0].Checkpoint))
	if !valid || stored.Version != 2 || len(stored.V2.Turns) != 2 || stored.V2.NativeProjection == nil {
		t.Fatalf("converted mapping checkpoint was not upgraded: %+v", stored)
	}
	secondPreview, err := service.Call(context.Background(), Request{Action: "preview", Source: domain.SourceCodex, Workspace: advanced.Summary.Workspace, Mode: ModeSync, SessionIDs: []string{advanced.Summary.ID}})
	if err != nil {
		t.Fatalf("preview reconciled task: %v", err)
	}
	var second struct {
		Sessions []struct {
			Sync SyncPreview `json:"sync"`
		} `json:"sessions"`
	}
	if err = json.Unmarshal(secondPreview, &second); err != nil || len(second.Sessions) != 1 || second.Sessions[0].Sync.Status != "up-to-date" {
		t.Fatalf("converted task did not become current after reconciliation: err=%v response=%s", err, secondPreview)
	}
}

func TestServiceAdoptsClaudeBuiltinImportByAttachingVerifiedHead(t *testing.T) {
	root := t.TempDir()
	t.Setenv("T3_IMPORT_DATA_DIR", filepath.Join(root, "ledger"))
	paths := makeV2Target(t, filepath.Join(root, "state"))
	conversation := sampleConversation()
	conversation.Threads[0].LeafID = stringPtr("leaf")
	conversation.Threads[0].ResumeCursor = map[string]any{"resume": "session-1", "resumeSessionAt": "assistant-node", "turnCount": 1}
	conversation.Threads[0].Turns[0].Assistant[0].SourceID = "assistant-node:text:0"
	threadID := "import:claudeAgent:session-1"
	projectID := "project-built-in-claude"
	db, err := sqlite.Open(paths.DBPath, sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at,deleted_at,default_model_selection_json) VALUES(?,?,?,?,?,?,NULL,?)`, projectID, "Workspace", conversation.Summary.Workspace, "[]", conversation.Summary.CreatedAt, conversation.Summary.UpdatedAt, "{}"); err != nil {
		t.Fatal(err)
	}
	plan, err := v2.BuildPlanWithRuntimeOptions(conversation.Threads[0], threadID, projectID, "claudeAgent", conversation.Threads[0].Model, map[string]any{}, false, paths.AttachmentsDir, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = v2.AppendPlan(context.Background(), db, plan); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	eventsBefore := targetEventCount(t, paths.DBPath)
	service := &Service{Paths: paths, Sources: registry.NewWith(&fixedSource{conversation: conversation})}
	reset := false
	response, err := service.Call(context.Background(), Request{Action: "execute", Source: domain.SourceClaude, Workspace: conversation.Summary.Workspace, SessionIDs: []string{conversation.Summary.ID}, Confirmed: true, ResetCache: &reset})
	if err != nil {
		t.Fatalf("adopt Claude built-in import: %v", err)
	}
	var result struct {
		Imported struct {
			Results []struct {
				Status   string `json:"status"`
				ThreadID string `json:"threadId"`
			} `json:"results"`
		} `json:"imported"`
	}
	if err := json.Unmarshal(response, &result); err != nil || len(result.Imported.Results) != 1 || result.Imported.Results[0].Status != "adopted" || result.Imported.Results[0].ThreadID != threadID {
		t.Fatalf("unexpected Claude adoption response: %v (%s)", err, response)
	}
	if after := targetEventCount(t, paths.DBPath); after != eventsBefore+1 {
		t.Fatalf("Claude adoption should append only its head attachment event: before=%d after=%d", eventsBefore, after)
	}
	db, err = sqlite.Open(paths.DBPath, sqlite.Options{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	var payload string
	if err := db.QueryRow(`SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id=?`, threadID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	var binding map[string]any
	if err := json.Unmarshal([]byte(payload), &binding); err != nil {
		t.Fatal(err)
	}
	head, _ := binding["nativeConversationHeadRef"].(map[string]any)
	if head["driver"] != "claudeAgent" || head["nativeId"] != "assistant-node" || head["strength"] != "strong" {
		t.Fatalf("Claude source head was not attached: %#v", binding["nativeConversationHeadRef"])
	}
}

func TestServiceRecoversExactV2ImportWhenLedgerIsMissing(t *testing.T) {
	root := t.TempDir()
	ledgerDir := filepath.Join(root, "ledger")
	t.Setenv("T3_IMPORT_DATA_DIR", ledgerDir)
	paths := makeV2Target(t, filepath.Join(root, "state"))
	source := &fixedSource{conversation: sampleConversation()}
	source.conversation.Threads[0].ResumeCursor = map[string]any{"resume": "session-1", "resumeSessionAt": "turn-1:assistant", "turnCount": 1}
	service := &Service{Paths: paths, Sources: registry.NewWith(source)}
	noCacheReset := false
	request := Request{Action: "execute", Source: domain.SourceClaude, Workspace: source.conversation.Summary.Workspace, SessionIDs: []string{source.conversation.Summary.ID}, Confirmed: true, ResetCache: &noCacheReset}
	if _, err := service.Call(context.Background(), request); err != nil {
		t.Fatalf("initial v2 import: %v", err)
	}
	targetDB, err := sqlite.Open(paths.DBPath, sqlite.Options{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	var eventsBefore int
	if err := targetDB.QueryRow(`SELECT COUNT(*) FROM orchestration_events`).Scan(&eventsBefore); err != nil {
		t.Fatal(err)
	}
	_ = targetDB.Close()
	ledgerPath, err := ledger.DefaultPath()
	if err != nil {
		t.Fatal(err)
	}
	ledgerDB, err := sqlite.Open(ledgerPath, sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ledgerDB.Exec(`DELETE FROM imports`); err != nil {
		t.Fatal(err)
	}
	_ = ledgerDB.Close()
	preview, err := service.Call(context.Background(), Request{Action: "preview", Source: request.Source, Workspace: request.Workspace, Mode: ModeSync, SessionIDs: request.SessionIDs})
	if err != nil {
		t.Fatalf("recovery preview: %v", err)
	}
	var previewResult struct {
		Sessions []PreviewSession `json:"sessions"`
	}
	if err := json.Unmarshal(preview, &previewResult); err != nil || len(previewResult.Sessions) != 1 || previewResult.Sessions[0].Sync.Status != "syncable" || !previewResult.Sessions[0].Sync.Selectable || previewResult.Sessions[0].Sync.NewTurns != 0 {
		t.Fatalf("recovery preview: %v (%s)", err, preview)
	}
	request.Mode = ModeSync
	recovered, err := service.Call(context.Background(), request)
	if err != nil {
		t.Fatalf("recover v2 ledger: %v", err)
	}
	var result struct {
		Synced struct {
			Status   string   `json:"status"`
			Warnings []string `json:"warnings"`
		} `json:"synced"`
	}
	if err := json.Unmarshal(recovered, &result); err != nil || result.Synced.Status != "synced" || !strings.Contains(strings.Join(result.Synced.Warnings, " "), "Recovered a verified import ledger mapping") {
		t.Fatalf("recovery result: %v (%s)", err, recovered)
	}
	ledgerDB, err = sqlite.Open(ledgerPath, sqlite.Options{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	var ledgerRows int
	if err := ledgerDB.QueryRow(`SELECT COUNT(*) FROM imports`).Scan(&ledgerRows); err != nil {
		t.Fatal(err)
	}
	_ = ledgerDB.Close()
	targetDB, err = sqlite.Open(paths.DBPath, sqlite.Options{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	var eventsAfter int
	if err := targetDB.QueryRow(`SELECT COUNT(*) FROM orchestration_events`).Scan(&eventsAfter); err != nil {
		t.Fatal(err)
	}
	_ = targetDB.Close()
	if ledgerRows != 1 || eventsAfter != eventsBefore {
		t.Fatalf("recovery replayed history or failed to save ledger: ledgerRows=%d eventsBefore=%d eventsAfter=%d", ledgerRows, eventsBefore, eventsAfter)
	}
}

func TestServiceRecoversExactLegacyImportWhenLedgerIsMissing(t *testing.T) {
	root := t.TempDir()
	ledgerDir := filepath.Join(root, "ledger")
	t.Setenv("T3_IMPORT_DATA_DIR", ledgerDir)
	paths := makeLegacyTarget(t, filepath.Join(root, "state"))
	source := &fixedSource{conversation: sampleConversation()}
	service := &Service{Paths: paths, Sources: registry.NewWith(source)}
	noCacheReset := false
	request := Request{Action: "execute", Source: domain.SourceClaude, Workspace: source.conversation.Summary.Workspace, SessionIDs: []string{source.conversation.Summary.ID}, Confirmed: true, ResetCache: &noCacheReset}
	if _, err := service.Call(context.Background(), request); err != nil {
		t.Fatalf("initial legacy import: %v", err)
	}
	targetDB, err := sqlite.Open(paths.DBPath, sqlite.Options{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	var eventsBefore int
	if err := targetDB.QueryRow(`SELECT COUNT(*) FROM orchestration_events`).Scan(&eventsBefore); err != nil {
		t.Fatal(err)
	}
	_ = targetDB.Close()
	ledgerPath, err := ledger.DefaultPath()
	if err != nil {
		t.Fatal(err)
	}
	ledgerDB, err := sqlite.Open(ledgerPath, sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ledgerDB.Exec(`DELETE FROM imports`); err != nil {
		t.Fatal(err)
	}
	_ = ledgerDB.Close()
	preview, err := service.Call(context.Background(), Request{Action: "preview", Source: request.Source, Workspace: request.Workspace, Mode: ModeSync, SessionIDs: request.SessionIDs})
	if err != nil {
		t.Fatalf("legacy recovery preview: %v", err)
	}
	var previewResult struct {
		Sessions []PreviewSession `json:"sessions"`
	}
	if err := json.Unmarshal(preview, &previewResult); err != nil || len(previewResult.Sessions) != 1 || previewResult.Sessions[0].Sync.Status != "syncable" || !previewResult.Sessions[0].Sync.Selectable || previewResult.Sessions[0].Sync.NewTurns != 0 {
		t.Fatalf("legacy recovery preview: %v (%s)", err, preview)
	}
	request.Mode = ModeSync
	recovered, err := service.Call(context.Background(), request)
	if err != nil {
		t.Fatalf("recover legacy ledger: %v", err)
	}
	var result struct {
		Synced struct {
			Status   string   `json:"status"`
			Warnings []string `json:"warnings"`
		} `json:"synced"`
	}
	if err := json.Unmarshal(recovered, &result); err != nil || result.Synced.Status != "synced" || !strings.Contains(strings.Join(result.Synced.Warnings, " "), "Recovered a verified import ledger mapping") {
		t.Fatalf("legacy recovery result: %v (%s)", err, recovered)
	}
	ledgerDB, err = sqlite.Open(ledgerPath, sqlite.Options{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	var ledgerRows int
	if err := ledgerDB.QueryRow(`SELECT COUNT(*) FROM imports`).Scan(&ledgerRows); err != nil {
		t.Fatal(err)
	}
	_ = ledgerDB.Close()
	targetDB, err = sqlite.Open(paths.DBPath, sqlite.Options{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	var eventsAfter int
	if err := targetDB.QueryRow(`SELECT COUNT(*) FROM orchestration_events`).Scan(&eventsAfter); err != nil {
		t.Fatal(err)
	}
	_ = targetDB.Close()
	if ledgerRows != 1 || eventsAfter != eventsBefore {
		t.Fatalf("legacy recovery replayed history or failed to save ledger: ledgerRows=%d eventsBefore=%d eventsAfter=%d", ledgerRows, eventsBefore, eventsAfter)
	}
}

func sampleConversation() domain.CanonicalConversation {
	summary := domain.SourceSummary{Source: domain.SourceClaude, ID: "session-1", Title: "Task", Workspace: "/workspace", Path: "/transcript.jsonl", CreatedAt: "2026-01-01T00:00:00.000Z", UpdatedAt: "2026-01-01T00:00:02.000Z", Status: domain.SummaryComplete, Branches: 1}
	thread := domain.CanonicalThread{Source: domain.SourceClaude, SourceSessionID: summary.ID, SourceKey: "claude:session-1", CurrentBranch: true, Title: summary.Title, Workspace: summary.Workspace, Model: "claude-test", CreatedAt: summary.CreatedAt, UpdatedAt: summary.UpdatedAt, Turns: []domain.CanonicalTurn{canonicalTurn("turn-1", "first question", "first answer")}}
	return domain.CanonicalConversation{Summary: summary, Threads: []domain.CanonicalThread{thread}, Fingerprint: "fingerprint-1"}
}

func canonicalTurn(id, userText, assistantText string) domain.CanonicalTurn {
	return domain.CanonicalTurn{ID: id, StartedAt: "2026-01-01T00:00:00.000Z", CompletedAt: stringPtr("2026-01-01T00:00:02.000Z"), Status: domain.TurnCompleted, User: domain.CanonicalMessage{SourceID: id + ":user", Role: "user", Text: userText, Timestamp: "2026-01-01T00:00:00.000Z"}, Assistant: []domain.CanonicalMessage{{SourceID: id + ":assistant", Role: "assistant", Text: assistantText, Timestamp: "2026-01-01T00:00:02.000Z"}}}
}

func stringPtr(value string) *string { return &value }

func makeLegacyTarget(t *testing.T, stateDir string) config.TargetPaths {
	t.Helper()
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	paths := config.TargetPaths{T3Home: filepath.Dir(stateDir), StateDir: stateDir, DBPath: filepath.Join(stateDir, "state.sqlite"), AttachmentsDir: filepath.Join(stateDir, "attachments"), RuntimeStatePath: filepath.Join(stateDir, "server-runtime.json")}
	db, err := sqlite.Open(paths.DBPath, sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	ddl := []string{
		`CREATE TABLE effect_sql_migrations(migration_id INTEGER,name TEXT,created_at TEXT)`,
		`INSERT INTO effect_sql_migrations VALUES(53,'latest','now')`,
		`CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE,aggregate_kind TEXT,stream_id TEXT,stream_version INTEGER,event_type TEXT,occurred_at TEXT,command_id TEXT,causation_event_id TEXT,correlation_id TEXT,actor_kind TEXT,payload_json TEXT,metadata_json TEXT,UNIQUE(aggregate_kind,stream_id,stream_version))`,
		`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT)`,
		`CREATE TABLE projection_state(projector TEXT,last_applied_sequence INTEGER)`,
		`CREATE TABLE provider_session_runtime(thread_id TEXT PRIMARY KEY,provider_name TEXT NOT NULL,provider_instance_id TEXT,adapter_key TEXT NOT NULL,runtime_mode TEXT NOT NULL,status TEXT NOT NULL,last_seen_at TEXT NOT NULL,resume_cursor_json TEXT,runtime_payload_json TEXT)`,
	}
	for _, statement := range ddl {
		if _, err := db.Exec(statement); err != nil {
			_ = db.Close()
			t.Fatalf("create app target fixture: %v", err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return paths
}

func makeV2Target(t *testing.T, stateDir string) config.TargetPaths {
	t.Helper()
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	paths := config.TargetPaths{T3Home: filepath.Dir(stateDir), StateDir: stateDir, DBPath: filepath.Join(stateDir, "statev2.sqlite"), AttachmentsDir: filepath.Join(stateDir, "attachments"), RuntimeStatePath: filepath.Join(stateDir, "server-runtime.json")}
	db, err := sqlite.Open(paths.DBPath, sqlite.Options{})
	if err != nil {
		t.Fatal(err)
	}
	ddl := []string{
		`CREATE TABLE effect_sql_migrations(migration_id INTEGER,name TEXT,created_at TEXT)`,
		`INSERT INTO effect_sql_migrations VALUES(55,'OrchestrationV2','now'),(61,'PullRequestReviewGuides','now')`,
		`CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY,event_id TEXT UNIQUE,aggregate_kind TEXT,stream_id TEXT,stream_version INTEGER,event_type TEXT,occurred_at TEXT,command_id TEXT,causation_event_id TEXT,correlation_id TEXT,actor_kind TEXT,payload_json TEXT,metadata_json TEXT,application_event_version INTEGER)`,
		`CREATE TABLE orchestration_v2_projection_metadata(projection_name TEXT,schema_version INTEGER,last_sequence INTEGER,updated_at TEXT)`,
		`INSERT INTO orchestration_v2_projection_metadata VALUES('thread-projections',1,0,'now')`,
		`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY,title TEXT,workspace_root TEXT,scripts_json TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,default_model_selection_json TEXT)`,
		`CREATE TABLE projection_state(projector TEXT,last_applied_sequence INTEGER)`,
		`CREATE TABLE provider_session_runtime(thread_id TEXT PRIMARY KEY,provider_name TEXT,provider_instance_id TEXT,adapter_key TEXT,runtime_mode TEXT,status TEXT,last_seen_at TEXT,resume_cursor_json TEXT,runtime_payload_json TEXT)`,
		`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,project_id TEXT,title TEXT,default_provider TEXT,provider_instance_id TEXT,runtime_mode TEXT,interaction_mode TEXT,active_provider_thread_id TEXT,created_at TEXT,updated_at TEXT,archived_at TEXT,deleted_at TEXT,payload_json TEXT)`,
		`CREATE TABLE orchestration_v2_projection_messages(message_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,node_id TEXT,role TEXT,streaming INTEGER,created_at TEXT,updated_at TEXT,payload_json TEXT)`,
		`CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,node_id TEXT,provider_thread_id TEXT,provider_turn_id TEXT,parent_item_id TEXT,ordinal INTEGER,type TEXT,status TEXT,updated_at TEXT,payload_json TEXT)`,
		`CREATE TABLE orchestration_v2_turn_item_positions(thread_id TEXT,turn_item_id TEXT,ordinal INTEGER)`,
		`CREATE TABLE orchestration_v2_projection_plans(plan_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,node_id TEXT,kind TEXT,status TEXT,payload_json TEXT)`,
		`CREATE TABLE orchestration_v2_projection_provider_threads(provider_thread_id TEXT PRIMARY KEY,thread_id TEXT,owner_node_id TEXT,provider TEXT,driver TEXT,provider_instance_id TEXT,provider_session_id TEXT,status TEXT,first_run_ordinal INTEGER,last_run_ordinal INTEGER,updated_at TEXT,payload_json TEXT)`,
		`CREATE TABLE orchestration_v2_projection_provider_sessions(provider_session_id TEXT,thread_id TEXT,provider TEXT,status TEXT,model TEXT,updated_at TEXT,payload_json TEXT,driver TEXT,provider_instance_id TEXT)`,
		`CREATE TABLE orchestration_v2_projection_runs(thread_id TEXT,payload_json TEXT)`,
		`CREATE TABLE orchestration_v2_projection_run_attempts(thread_id TEXT,payload_json TEXT)`,
		`CREATE TABLE orchestration_v2_projection_nodes(thread_id TEXT,payload_json TEXT)`,
		`CREATE TABLE orchestration_v2_projection_checkpoints(thread_id TEXT,payload_json TEXT)`,
		`CREATE TABLE orchestration_v2_projection_checkpoint_scopes(thread_id TEXT,payload_json TEXT)`,
	}
	for _, statement := range ddl {
		if _, err := db.Exec(statement); err != nil {
			_ = db.Close()
			t.Fatalf("create v2 app target fixture: %v", err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return paths
}

func targetEventCount(t *testing.T, path string) int {
	t.Helper()
	db, err := sqlite.Open(path, sqlite.Options{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM orchestration_events`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func eventPayloadForTest(t *testing.T, event v2.Event) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

var _ domain.SourceAdapter = (*fixedSource)(nil)
