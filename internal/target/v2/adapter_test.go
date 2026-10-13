package v2

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"

	"github.com/CarlosGtrz/t3-import/internal/domain"
	_ "modernc.org/sqlite"
)

func fixture(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	ddl := []string{
		`CREATE TABLE effect_sql_migrations(migration_id INTEGER,name TEXT,created_at TEXT)`,
		`INSERT INTO effect_sql_migrations VALUES(55,'OrchestrationV2','now'),(61,'PullRequestReviewGuides','now')`,
		`CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY,event_id TEXT UNIQUE,aggregate_kind TEXT,stream_id TEXT,stream_version INTEGER,event_type TEXT,occurred_at TEXT,command_id TEXT,causation_event_id TEXT,correlation_id TEXT,actor_kind TEXT,payload_json TEXT,metadata_json TEXT,application_event_version INTEGER)`,
		`CREATE TABLE orchestration_v2_projection_metadata(projection_name TEXT,schema_version INTEGER,last_sequence INTEGER,updated_at TEXT)`,
		`INSERT INTO orchestration_v2_projection_metadata VALUES('thread-projections',1,0,'now')`,
		`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY,title TEXT,workspace_root TEXT,scripts_json TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,default_model_selection_json TEXT)`,
		`INSERT INTO projection_projects VALUES('p-1','p','/work','[]','now','now',NULL,'{}')`,
		`CREATE TABLE projection_state(projector TEXT,last_applied_sequence INTEGER)`,
		`CREATE TABLE provider_session_runtime(thread_id TEXT PRIMARY KEY,provider_name TEXT,provider_instance_id TEXT,adapter_key TEXT,runtime_mode TEXT,status TEXT,last_seen_at TEXT,resume_cursor_json TEXT,runtime_payload_json TEXT)`,
		`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,project_id TEXT,title TEXT,default_provider TEXT,provider_instance_id TEXT,runtime_mode TEXT,interaction_mode TEXT,active_provider_thread_id TEXT,created_at TEXT,updated_at TEXT,archived_at TEXT,deleted_at TEXT,payload_json TEXT)`,
		`CREATE TABLE orchestration_v2_projection_messages(message_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,node_id TEXT,role TEXT,streaming INTEGER,created_at TEXT,updated_at TEXT,payload_json TEXT)`,
		`CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,node_id TEXT,provider_thread_id TEXT,provider_turn_id TEXT,parent_item_id TEXT,ordinal INTEGER,type TEXT,status TEXT,updated_at TEXT,payload_json TEXT)`,
		`CREATE TABLE orchestration_v2_turn_item_positions(thread_id TEXT,turn_item_id TEXT,ordinal INTEGER)`,
		`CREATE TABLE orchestration_v2_projection_plans(plan_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,node_id TEXT,kind TEXT,status TEXT,payload_json TEXT)`,
		`CREATE TABLE orchestration_v2_projection_provider_threads(provider_thread_id TEXT PRIMARY KEY,thread_id TEXT,owner_node_id TEXT,provider TEXT,driver TEXT,provider_instance_id TEXT,provider_session_id TEXT,status TEXT,first_run_ordinal INTEGER,last_run_ordinal INTEGER,updated_at TEXT,payload_json TEXT)`,
		`CREATE TABLE orchestration_v2_projection_provider_sessions(provider_session_id TEXT,thread_id TEXT,provider TEXT,status TEXT,model TEXT,updated_at TEXT,payload_json TEXT,driver TEXT,provider_instance_id TEXT)`,
	}
	for _, q := range ddl {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func raw(s string) json.RawMessage { return json.RawMessage(s) }

func TestAppendProjectsAndReadsPinnedEvents(t *testing.T) {
	db := fixture(t)
	ctx := context.Background()
	created := Event{ID: "e-create", Type: "thread.created", ThreadID: "t-1", OccurredAt: "2026-01-01T00:00:00.000Z", Payload: raw(`{"id":"t-1","projectId":"p-1","title":"hello","providerInstanceId":"codex","runtimeMode":"full-access","interactionMode":"default","activeProviderThreadId":"pt-1","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}`)}
	message := Event{ID: "e-message", Type: "message.updated", ThreadID: "t-1", OccurredAt: "2026-01-01T00:00:01.000Z", Payload: raw(`{"id":"m-1","threadId":"t-1","runId":null,"nodeId":null,"role":"user","text":"hi","streaming":false,"createdAt":"2026-01-01T00:00:01.000Z","updatedAt":"2026-01-01T00:00:01.000Z","attachments":[]}`)}
	written, err := Append(ctx, db, "codex", "p-1", []Event{created, message})
	if err != nil {
		t.Fatal(err)
	}
	if len(written) != 2 || written[0].Sequence >= written[1].Sequence {
		t.Fatalf("bad stored order: %+v", written)
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM orchestration_v2_projection_messages WHERE message_id='m-1'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("message projection count=%d err=%v", count, err)
	}
	var cursor int64
	if err := db.QueryRow(`SELECT last_sequence FROM orchestration_v2_projection_metadata`).Scan(&cursor); err != nil || cursor != 2 {
		t.Fatalf("cursor=%d err=%v", cursor, err)
	}
	read, err := Read(ctx, db, "t-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(read) != 2 || read[1].Event.ID != "e-message" || string(read[1].Event.Payload) != string(message.Payload) {
		t.Fatalf("readback mismatch: %+v", read)
	}
	encoded, err := StableEventJSON(message)
	if err != nil || !strings.Contains(string(encoded), `"text":"hi"`) {
		t.Fatalf("stable encoding: %s %v", encoded, err)
	}
}

func TestAppendConflictIsAtomicAndUnknownProfileFailsClosed(t *testing.T) {
	db := fixture(t)
	ctx := context.Background()
	bad := Event{ID: "e", Type: "thread.created", ThreadID: "t-1", OccurredAt: "2026-01-01T00:00:00Z", Payload: raw(`{"id":"wrong","projectId":"p-1"}`)}
	if _, err := Append(ctx, db, "codex", "p-1", []Event{bad}); err == nil {
		t.Fatal("expected identity conflict")
	}
	var count int
	_ = db.QueryRow(`SELECT count(*) FROM orchestration_events`).Scan(&count)
	if count != 0 {
		t.Fatalf("partial event write: %d", count)
	}
	if _, err := db.Exec(`UPDATE effect_sql_migrations SET name='unknown' WHERE migration_id=61`); err != nil {
		t.Fatal(err)
	}
	if _, err := Append(ctx, db, "codex", "p-1", []Event{bad}); err == nil || !strings.Contains(err.Error(), "unsupported T3 schema profile") {
		t.Fatalf("expected fail-closed profile error, got %v", err)
	}
}

func TestBuildPlanProjectAndThreadAreAtomicAndOrdered(t *testing.T) {
	db := fixture(t)
	ctx := context.Background()
	at := "2026-01-01T00:00:00.000Z"
	thread := domain.CanonicalThread{Source: domain.SourceCodex, SourceSessionID: "session", SourceKey: "codex:session", Title: "Thread", Workspace: "/work", Model: "gpt-test", CreatedAt: at, UpdatedAt: at, CurrentBranch: true, Turns: []domain.CanonicalTurn{{ID: "turn", StartedAt: at, Status: domain.TurnCompleted, User: domain.CanonicalMessage{SourceID: "u", Role: "user", Text: "hello", Timestamp: at}, Assistant: []domain.CanonicalMessage{{SourceID: "a", Role: "assistant", Text: "world", Timestamp: at}}}}}
	plan, err := BuildPlan(thread, "thread-2", "p-2", "codex", map[string]any{}, true)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := AppendPlan(ctx, db, plan)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 6 {
		t.Fatalf("thread event count %d", len(stored))
	}
	var projectSeq, threadSeq int64
	if err = db.QueryRow(`SELECT sequence FROM orchestration_events WHERE aggregate_kind='project' AND stream_id='p-2'`).Scan(&projectSeq); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(`SELECT MIN(sequence) FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id='thread-2'`).Scan(&threadSeq); err != nil {
		t.Fatal(err)
	}
	if projectSeq >= threadSeq {
		t.Fatalf("project sequence %d should precede thread %d", projectSeq, threadSeq)
	}
	var workspace string
	if err = db.QueryRow(`SELECT workspace_root FROM projection_projects WHERE project_id='p-2'`).Scan(&workspace); err != nil || workspace != "/work" {
		t.Fatalf("project projection workspace %q err=%v", workspace, err)
	}
	if _, err = Read(ctx, db, "thread-2"); err != nil {
		t.Fatal(err)
	}
}

func TestAppendPlanRollsBackProjectWhenThreadEventConflicts(t *testing.T) {
	db := fixture(t)
	ctx := context.Background()
	at := "2026-01-01T00:00:00.000Z"
	thread := domain.CanonicalThread{Source: domain.SourceCodex, SourceSessionID: "s", SourceKey: "codex:s", Workspace: "/work", CreatedAt: at, UpdatedAt: at, Turns: []domain.CanonicalTurn{{ID: "t", StartedAt: at, Status: domain.TurnCompleted, User: domain.CanonicalMessage{SourceID: "u", Role: "user", Timestamp: at}, Assistant: []domain.CanonicalMessage{{SourceID: "a", Role: "assistant", Timestamp: at}}}}}
	plan, err := BuildPlan(thread, "thread-3", "p-3", "codex", nil, true)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json,application_event_version) VALUES(1,?,'thread','elsewhere',0,'thread.created',?,NULL,NULL,NULL,'server','{}','{}',2)`, plan.Events[0].ID, at)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = AppendPlan(ctx, db, plan); err == nil {
		t.Fatal("expected deterministic event conflict")
	}
	var projects, created int
	_ = db.QueryRow(`SELECT count(*) FROM projection_projects WHERE project_id='p-3'`).Scan(&projects)
	_ = db.QueryRow(`SELECT count(*) FROM orchestration_events WHERE aggregate_kind='project' AND stream_id='p-3'`).Scan(&created)
	if projects != 0 || created != 0 {
		t.Fatalf("project not rolled back: rows=%d events=%d", projects, created)
	}
}

func TestResumablePlanWritesNativeBindingAndStoppedRuntime(t *testing.T) {
	db := fixture(t)
	ctx := context.Background()
	at := "2026-01-01T00:00:00.000Z"
	thread := domain.CanonicalThread{Source: domain.SourceCodex, SourceSessionID: "native-session", SourceKey: "codex:native-session", CurrentBranch: true, Workspace: "/work", Model: "source-model", CreatedAt: at, UpdatedAt: at, ResumeCursor: map[string]any{"threadId": "native-session"}, Turns: []domain.CanonicalTurn{{ID: "turn", StartedAt: at, Status: domain.TurnCompleted, User: domain.CanonicalMessage{SourceID: "u", Role: "user", Text: "hello", Timestamp: at}, Assistant: []domain.CanonicalMessage{{SourceID: "a", Role: "assistant", Text: "world", Timestamp: at}}}}}
	plan, err := BuildPlanWithRuntimeOptions(thread, "target-thread", "p-1", "codex-instance", "selected-model", map[string]any{"effort": "high"}, false, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Runtime == nil || plan.Runtime.ThreadID != "target-thread" {
		t.Fatalf("runtime binding missing from resumable plan: %+v", plan.Runtime)
	}
	var providerPayload map[string]any
	for _, event := range plan.Events {
		if event.Type == "provider-thread.updated" {
			if err := json.Unmarshal(event.Payload, &providerPayload); err != nil {
				t.Fatal(err)
			}
		}
	}
	ref, ok := providerPayload["nativeThreadRef"].(map[string]any)
	if !ok || ref["driver"] != "codex" || ref["nativeId"] != "native-session" || ref["strength"] != "strong" {
		t.Fatalf("unexpected native thread reference: %#v", providerPayload["nativeThreadRef"])
	}
	var modelSelection map[string]any
	if err := json.Unmarshal(plan.Events[0].Payload, &providerPayload); err != nil {
		t.Fatal(err)
	}
	modelSelection, ok = providerPayload["modelSelection"].(map[string]any)
	if !ok || modelSelection["model"] != "selected-model" {
		t.Fatalf("resolved provider model was not used: %#v", providerPayload["modelSelection"])
	}
	if _, err := AppendPlan(ctx, db, plan); err != nil {
		t.Fatal(err)
	}
	var status, cursor string
	if err := db.QueryRow(`SELECT status,resume_cursor_json FROM provider_session_runtime WHERE thread_id='target-thread'`).Scan(&status, &cursor); err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(cursor), &decoded); err != nil || status != "stopped" || decoded["threadId"] != "native-session" {
		t.Fatalf("runtime binding status=%q cursor=%s err=%v", status, cursor, err)
	}

	claude := thread
	claude.Source = domain.SourceClaude
	claude.SourceSessionID = "claude-session"
	claude.SourceKey = "claude:claude-session"
	claude.ResumeCursor = map[string]any{"resume": "claude-native-session", "resumeSessionAt": "assistant-id", "turnCount": 1}
	claudePlan, err := BuildPlanWithRuntimeOptions(claude, "claude-target-thread", "p-1", "claude-instance", "claude-selected-model", nil, false, "", true)
	if err != nil {
		t.Fatal(err)
	}
	var claudeProviderPayload map[string]any
	for _, event := range claudePlan.Events {
		if event.Type == "provider-thread.updated" {
			if err := json.Unmarshal(event.Payload, &claudeProviderPayload); err != nil {
				t.Fatal(err)
			}
		}
	}
	claudeRef, ok := claudeProviderPayload["nativeThreadRef"].(map[string]any)
	if !ok || claudeRef["driver"] != "claudeAgent" || claudeRef["nativeId"] != "claude-native-session" || claudeRef["strength"] != "strong" {
		t.Fatalf("unexpected Claude native thread reference: %#v", claudeProviderPayload["nativeThreadRef"])
	}
	if _, err := AppendPlan(ctx, db, claudePlan); err != nil {
		t.Fatal(err)
	}
	var claudeCursor string
	if err := db.QueryRow(`SELECT resume_cursor_json FROM provider_session_runtime WHERE thread_id='claude-target-thread'`).Scan(&claudeCursor); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(claudeCursor), &decoded); err != nil || decoded["threadId"] != "claude-target-thread" || decoded["resume"] != "claude-native-session" {
		t.Fatalf("Claude runtime cursor=%s err=%v", claudeCursor, err)
	}
}

func TestNoResumePlanOmitsNativeBindingAndRuntime(t *testing.T) {
	db := fixture(t)
	ctx := context.Background()
	at := "2026-01-01T00:00:00.000Z"
	thread := domain.CanonicalThread{Source: domain.SourceCodex, SourceSessionID: "native-session", SourceKey: "codex:native-session", CurrentBranch: true, Workspace: "/work", Model: "model", CreatedAt: at, UpdatedAt: at, ResumeCursor: map[string]any{"threadId": "native-session"}, Turns: []domain.CanonicalTurn{{ID: "turn", StartedAt: at, Status: domain.TurnCompleted, User: domain.CanonicalMessage{SourceID: "u", Role: "user", Timestamp: at}, Assistant: []domain.CanonicalMessage{{SourceID: "a", Role: "assistant", Timestamp: at}}}}}
	plan, err := BuildPlanWithRuntimeOptions(thread, "target-thread", "p-1", "codex", "model", nil, false, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Runtime != nil {
		t.Fatalf("no-resume plan unexpectedly has runtime binding: %+v", plan.Runtime)
	}
	var payload map[string]any
	for _, event := range plan.Events {
		if event.Type == "provider-thread.updated" {
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				t.Fatal(err)
			}
		}
	}
	if payload["nativeThreadRef"] != nil {
		t.Fatalf("no-resume plan unexpectedly exposes native reference: %#v", payload["nativeThreadRef"])
	}
	if _, err := AppendPlan(ctx, db, plan); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM provider_session_runtime WHERE thread_id='target-thread'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("runtime rows=%d err=%v", count, err)
	}
}

func TestRuntimeWriteFailureRollsBackV2Plan(t *testing.T) {
	db := fixture(t)
	ctx := context.Background()
	at := "2026-01-01T00:00:00.000Z"
	thread := domain.CanonicalThread{Source: domain.SourceCodex, SourceSessionID: "native-session", SourceKey: "codex:native-session", CurrentBranch: true, Workspace: "/new-work", Model: "model", CreatedAt: at, UpdatedAt: at, ResumeCursor: map[string]any{"threadId": "native-session"}, Turns: []domain.CanonicalTurn{{ID: "turn", StartedAt: at, Status: domain.TurnCompleted, User: domain.CanonicalMessage{SourceID: "u", Role: "user", Timestamp: at}, Assistant: []domain.CanonicalMessage{{SourceID: "a", Role: "assistant", Timestamp: at}}}}}
	plan, err := BuildPlanWithRuntimeOptions(thread, "target-thread", "new-project", "codex", "model", nil, true, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TRIGGER reject_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT,'runtime write blocked'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err = AppendPlan(ctx, db, plan); err == nil {
		t.Fatal("expected runtime write to fail")
	}
	var projects, threadEvents, runtimeRows int
	_ = db.QueryRow(`SELECT COUNT(*) FROM projection_projects WHERE project_id='new-project'`).Scan(&projects)
	_ = db.QueryRow(`SELECT COUNT(*) FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id='target-thread'`).Scan(&threadEvents)
	_ = db.QueryRow(`SELECT COUNT(*) FROM provider_session_runtime WHERE thread_id='target-thread'`).Scan(&runtimeRows)
	if projects != 0 || threadEvents != 0 || runtimeRows != 0 {
		t.Fatalf("failed runtime write left partial state projects=%d threadEvents=%d runtimeRows=%d", projects, threadEvents, runtimeRows)
	}
}

func TestBuildAndAppendSyncPlanRequiresExactPrefix(t *testing.T) {
	db := fixture(t)
	ctx := context.Background()
	at := "2026-01-01T00:00:00.000Z"
	thread := domain.CanonicalThread{Source: domain.SourceCodex, SourceSessionID: "sync", SourceKey: "codex:sync", Workspace: "/work", CreatedAt: at, UpdatedAt: at, Turns: []domain.CanonicalTurn{{ID: "turn", StartedAt: at, Status: domain.TurnCompleted, User: domain.CanonicalMessage{SourceID: "u", Role: "user", Text: "hello", Timestamp: at}, Assistant: []domain.CanonicalMessage{{SourceID: "a", Role: "assistant", Text: "world", Timestamp: at}}}}}
	full, err := BuildPlan(thread, "sync-thread", "p-1", "codex", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = AppendPlan(ctx, db, full); err != nil {
		t.Fatal(err)
	}
	stream, err := InspectThread(ctx, db, "sync-thread")
	if err != nil {
		t.Fatal(err)
	}
	continued := thread
	continued.Title = "renamed from source"
	continued.UpdatedAt = "2026-01-01T00:00:03.000Z"
	continued.Turns = append(continued.Turns, domain.CanonicalTurn{ID: "turn-2", StartedAt: continued.UpdatedAt, CompletedAt: &continued.UpdatedAt, Status: domain.TurnCompleted, User: domain.CanonicalMessage{SourceID: "u-2", Role: "user", Text: "next", Timestamp: continued.UpdatedAt}, Assistant: []domain.CanonicalMessage{{SourceID: "a-2", Role: "assistant", Text: "answer", Timestamp: continued.UpdatedAt}}})
	full, err = BuildPlan(continued, "sync-thread", "p-1", "codex", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := BuildSyncPlan(stream, full)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Events) != 4 {
		t.Fatalf("suffix has %d events, want the four message/item events for the new turn", len(plan.Events))
	}
	for _, event := range plan.Events {
		if event.Type == "provider-thread.updated" || event.Type == "thread.created" {
			t.Fatalf("sync suffix unexpectedly contains immutable metadata event %s", event.Type)
		}
	}
	if _, err = AppendSync(ctx, db, plan); err != nil {
		t.Fatal(err)
	}
	got, err := InspectThread(ctx, db, "sync-thread")
	if err != nil || len(got) != len(full.Events) {
		t.Fatalf("sync stream length=%d err=%v", len(got), err)
	}

	changed := full
	changed.Events = append([]Event(nil), full.Events...)
	changed.Events[0].Payload = raw(`{"id":"sync-thread","projectId":"edited-project","title":"edited"}`)
	if _, err = BuildSyncPlan(stream, changed); err == nil {
		t.Fatal("expected source/target divergence to fail closed")
	}
	changedBinding := append([]StoredEvent(nil), stream...)
	for i := range changedBinding {
		if changedBinding[i].Event.Type == "provider-thread.updated" {
			changedBinding[i].Event.Payload = raw(`{"id":"unexpected-provider-thread","appThreadId":"sync-thread","driver":"codex","providerInstanceId":"codex"}`)
		}
	}
	if _, err = BuildSyncPlan(changedBinding, full); err == nil {
		t.Fatal("expected provider identity divergence to fail closed")
	}
}

func TestAppendSyncRollsBackWhenExpectedHistoryChanged(t *testing.T) {
	db := fixture(t)
	ctx := context.Background()
	at := "2026-01-01T00:00:00.000Z"
	thread := domain.CanonicalThread{Source: domain.SourceCodex, SourceSessionID: "rollback", SourceKey: "codex:rollback", Workspace: "/work", CreatedAt: at, UpdatedAt: at, Turns: []domain.CanonicalTurn{{ID: "turn", StartedAt: at, Status: domain.TurnCompleted, User: domain.CanonicalMessage{SourceID: "u", Role: "user", Timestamp: at}, Assistant: []domain.CanonicalMessage{{SourceID: "a", Role: "assistant", Timestamp: at}}}}}
	full, err := BuildPlan(thread, "rollback-thread", "p-1", "codex", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = AppendPlan(ctx, db, full); err != nil {
		t.Fatal(err)
	}
	stream, err := InspectThread(ctx, db, "rollback-thread")
	if err != nil {
		t.Fatal(err)
	}
	bad := Event{ID: "rollback-extra", Type: "message.updated", ThreadID: "rollback-thread", OccurredAt: at, Payload: raw(`{"id":"rollback-extra-message","threadId":"rollback-thread","role":"assistant","text":"next","attachments":[],"streaming":false}`)}
	full.Events = append(full.Events, bad)
	plan, err := BuildSyncPlan(stream, full)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`UPDATE orchestration_events SET payload_json='{}' WHERE event_id=?`, stream[1].Event.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = AppendSync(ctx, db, plan); err == nil {
		t.Fatal("expected stale snapshot rejection")
	}
	var n int
	_ = db.QueryRow(`SELECT count(*) FROM orchestration_events WHERE event_id='rollback-extra'`).Scan(&n)
	if n != 0 {
		t.Fatalf("partial sync append: %d", n)
	}
}

func TestReplacementAppendsHistoryAndTombstoneAtomically(t *testing.T) {
	db := fixture(t)
	ctx := context.Background()
	at := "2026-01-01T00:00:00.000Z"
	oldThread := domain.CanonicalThread{Source: domain.SourceCodex, SourceSessionID: "old", SourceKey: "codex:old", CurrentBranch: true, ResumeCursor: map[string]any{"threadId": "native-old"}, Workspace: "/work", CreatedAt: at, UpdatedAt: at, Turns: []domain.CanonicalTurn{{ID: "t-old", StartedAt: at, Status: domain.TurnCompleted, User: domain.CanonicalMessage{SourceID: "u-old", Role: "user", Text: "old", Timestamp: at}, Assistant: []domain.CanonicalMessage{{SourceID: "a-old", Role: "assistant", Text: "answer", Timestamp: at}}}}}
	oldPlan, err := BuildPlanWithRuntimeOptions(oldThread, "old-thread", "p-1", "codex", "model", nil, false, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = AppendPlan(ctx, db, oldPlan); err != nil {
		t.Fatal(err)
	}
	old, err := InspectThread(ctx, db, "old-thread")
	if err != nil {
		t.Fatal(err)
	}
	nextThread := domain.CanonicalThread{Source: domain.SourceCodex, SourceSessionID: "old", SourceKey: "codex:old-replaced", CurrentBranch: true, ResumeCursor: oldThread.ResumeCursor, Workspace: "/work", CreatedAt: at, UpdatedAt: at, Turns: []domain.CanonicalTurn{{ID: "t-new", StartedAt: at, Status: domain.TurnCompleted, User: domain.CanonicalMessage{SourceID: "u-new", Role: "user", Text: "new", Timestamp: at}, Assistant: []domain.CanonicalMessage{{SourceID: "a-new", Role: "assistant", Text: "new answer", Timestamp: at}}}}}
	next, err := BuildPlanWithRuntimeOptions(nextThread, "new-thread", "p-1", "codex", "model", nil, false, "", true)
	if err != nil {
		t.Fatal(err)
	}
	replacement, err := BuildReplacementPlan(next, [][]StoredEvent{old}, at, false, false)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := AppendReplacement(ctx, db, replacement)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != len(next.Events)+1 {
		t.Fatalf("stored replacement events=%d", len(stored))
	}
	newEvents, err := InspectThread(ctx, db, "new-thread")
	if err != nil || len(newEvents) != len(next.Events) {
		t.Fatalf("new history=%d err=%v", len(newEvents), err)
	}
	oldEvents, err := Read(ctx, db, "old-thread")
	if err != nil || len(oldEvents) != len(old)+1 || oldEvents[len(oldEvents)-1].Event.Type != "thread.deleted" {
		t.Fatalf("old tombstone missing: %d %v", len(oldEvents), err)
	}
	var deleted sql.NullString
	if err = db.QueryRow(`SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id='old-thread'`).Scan(&deleted); err != nil || !deleted.Valid {
		t.Fatalf("deleted projection missing: %v %v", deleted, err)
	}
	var newCursor string
	if err = db.QueryRow(`SELECT resume_cursor_json FROM provider_session_runtime WHERE thread_id='new-thread'`).Scan(&newCursor); err != nil {
		t.Fatalf("replacement runtime binding missing: %v", err)
	}
	var cursor map[string]any
	if err = json.Unmarshal([]byte(newCursor), &cursor); err != nil || cursor["threadId"] != "native-old" {
		t.Fatalf("replacement runtime cursor=%s err=%v", newCursor, err)
	}
	var oldRuntimeRows int
	if err = db.QueryRow(`SELECT COUNT(*) FROM provider_session_runtime WHERE thread_id='old-thread'`).Scan(&oldRuntimeRows); err != nil || oldRuntimeRows != 0 {
		t.Fatalf("old runtime rows=%d err=%v", oldRuntimeRows, err)
	}
}

func TestReplacementConflictRollsBackProjectThreadAndTombstone(t *testing.T) {
	db := fixture(t)
	ctx := context.Background()
	at := "2026-01-01T00:00:00.000Z"
	oldThread := domain.CanonicalThread{Source: domain.SourceCodex, SourceSessionID: "old", SourceKey: "codex:old", Workspace: "/work", CreatedAt: at, UpdatedAt: at, Turns: []domain.CanonicalTurn{{ID: "t-old", StartedAt: at, Status: domain.TurnCompleted, User: domain.CanonicalMessage{SourceID: "u-old", Role: "user", Timestamp: at}, Assistant: []domain.CanonicalMessage{{SourceID: "a-old", Role: "assistant", Timestamp: at}}}}}
	oldPlan, err := BuildPlan(oldThread, "old-thread", "p-1", "codex", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = AppendPlan(ctx, db, oldPlan); err != nil {
		t.Fatal(err)
	}
	old, err := InspectThread(ctx, db, "old-thread")
	if err != nil {
		t.Fatal(err)
	}
	nextThread := oldThread
	nextThread.SourceKey = "codex:new"
	nextThread.Turns[0].User.SourceID = "u-new"
	nextThread.Turns[0].Assistant[0].SourceID = "a-new"
	next, err := BuildPlan(nextThread, "new-thread", "p-new", "codex", nil, true)
	if err != nil {
		t.Fatal(err)
	}
	// Force a deterministic event-ID collision after project creation has been staged.
	if _, err = db.Exec(`INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json,application_event_version) VALUES(999,'collision','thread','unrelated',0,'message.updated',? ,NULL,NULL,NULL,'server','{}','{}',2)`, at); err != nil {
		t.Fatal(err)
	}
	next.Events[1].ID = "collision"
	replacement, err := BuildReplacementPlan(next, [][]StoredEvent{old}, at, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = AppendReplacement(ctx, db, replacement); err == nil {
		t.Fatal("expected conflict")
	}
	var projects, threads, tombstones int
	_ = db.QueryRow(`SELECT count(*) FROM projection_projects WHERE project_id='p-new'`).Scan(&projects)
	_ = db.QueryRow(`SELECT count(*) FROM orchestration_v2_projection_threads WHERE thread_id='new-thread'`).Scan(&threads)
	_ = db.QueryRow(`SELECT count(*) FROM orchestration_events WHERE event_id=?`, replacement.Old[0].Tombstone.ID).Scan(&tombstones)
	if projects != 0 || threads != 0 || tombstones != 0 {
		t.Fatalf("replacement rollback failed projects=%d threads=%d tombstones=%d", projects, threads, tombstones)
	}
}

func TestEncodeHistoryMatchesV2TimelineOrderingAndImageShape(t *testing.T) {
	at := func(s string) string { return "2026-01-01T00:00:0" + s + ".000Z" }
	thread := domain.CanonicalThread{Source: domain.SourceCodex, SourceKey: "codex:gold", Turns: []domain.CanonicalTurn{{ID: "turn", Status: domain.TurnCompleted, User: domain.CanonicalMessage{SourceID: "u", Role: "user", Text: "look", Timestamp: at("1"), Attachments: []domain.SourceAttachment{{SourceID: "img", Name: "photo", MIMEType: "image/png", SizeBytes: 2, Data: &domain.Buffer{Data: []byte{1, 2}}}}}, Assistant: []domain.CanonicalMessage{{SourceID: "a", Role: "assistant", Text: "done", Timestamp: at("4")}}, Activities: []domain.CanonicalActivity{{SourceID: "reason", Kind: "reasoning.summary", Tone: domain.ToneInfo, Summary: "thinking", Payload: map[string]any{"detail": "private reasoning"}, Timestamp: at("2")}}}}}
	history, err := encodeHistory(thread, "thread", "/attachments")
	if err != nil {
		t.Fatal(err)
	}
	if len(history.Assets) != 1 || history.Assets[0].FinalPath != "/attachments/thread-"+uuid("t3-import:attachment:thread:img")+".png" {
		t.Fatalf("asset plan mismatch: %+v", history.Assets)
	}
	if got := history.Events[0].Type; got != "message.updated" {
		t.Fatalf("first event %s", got)
	}
	if got := history.Events[2].Type; got != "turn-item.updated" {
		t.Fatalf("second event %s", got)
	}
	if got := history.Events[2].Type; got != "turn-item.updated" {
		t.Fatalf("reasoning should sort before later assistant, got %s", got)
	}
	var item map[string]any
	if err := json.Unmarshal(history.Events[2].Payload, &item); err != nil {
		t.Fatal(err)
	}
	if item["ordinal"] != float64(2) || item["type"] != "reasoning" || item["text"] != "private reasoning" {
		t.Fatalf("reasoning payload mismatch: %#v", item)
	}
	var message map[string]any
	if err := json.Unmarshal(history.Events[0].Payload, &message); err != nil {
		t.Fatal(err)
	}
	attachments := message["attachments"].([]any)
	descriptor := attachments[0].(map[string]any)
	if descriptor["type"] != "image" || descriptor["id"] != "thread-"+uuid("t3-import:attachment:thread:img") || descriptor["name"] != "photo.png" {
		t.Fatalf("image descriptor mismatch: %#v", descriptor)
	}
}

func TestEncodeHistoryMapsUsageTerminalAndToolEvents(t *testing.T) {
	at := "2026-01-01T00:00:00.000Z"
	thread := domain.CanonicalThread{Source: domain.SourceClaude, SourceKey: "claude:gold", Turns: []domain.CanonicalTurn{{ID: "turn", Status: domain.TurnFailed, TerminalError: strPtr("bad"), User: domain.CanonicalMessage{SourceID: "u", Role: "user", Text: "x", Timestamp: at}, Assistant: []domain.CanonicalMessage{{SourceID: "a", Role: "assistant", Text: "y", Timestamp: at}}, Activities: []domain.CanonicalActivity{{SourceID: "tool", Kind: "tool.completed", Tone: domain.ToneTool, Summary: "Read", Timestamp: at, Payload: map[string]any{"itemType": "command_execution", "data": map[string]any{"item": map[string]any{"command": "cat x", "output": "ok"}}}}, {SourceID: "usage", Kind: "context-window.updated", Tone: domain.ToneInfo, Summary: "usage", Timestamp: at, Payload: map[string]any{"inputTokens": int64(3)}}, {SourceID: "err", Kind: "provider.error", Tone: domain.ToneError, Summary: "provider failed", Timestamp: at, Payload: map[string]any{"detail": "Bearer abc"}}}}}}
	history, err := encodeHistory(thread, "thread", "")
	if err != nil {
		t.Fatal(err)
	}
	types := map[string]int{}
	for _, e := range history.Events {
		types[e.Type]++
		if e.Type == "turn-item.updated" {
			var item map[string]any
			_ = json.Unmarshal(e.Payload, &item)
			if item["type"] == "command_execution" && (item["input"] != "cat x" || item["output"] != "ok") {
				t.Fatalf("tool mapping: %#v", item)
			}
			if item["type"] == "error" {
				failure := item["failure"].(map[string]any)
				if failure["message"] != "Bearer [redacted]" {
					t.Fatalf("redaction: %#v", failure)
				}
			}
		}
	}
	if types["turn-item.updated"] < 4 || types["message.updated"] != 2 {
		t.Fatalf("history events missing: %#v", types)
	}
	foundUsage, foundFailedAssistant := false, false
	for _, e := range history.Events {
		if e.Type != "turn-item.updated" {
			continue
		}
		var item map[string]any
		_ = json.Unmarshal(e.Payload, &item)
		if item["type"] == "system_notice" && strings.Contains(item["message"].(string), "inputTokens=3") {
			foundUsage = true
		}
		if item["type"] == "assistant_message" && item["status"] == "failed" {
			foundFailedAssistant = true
		}
	}
	if !foundUsage || !foundFailedAssistant {
		t.Fatalf("usage/failure terminal projection missing: usage=%v failedAssistant=%v", foundUsage, foundFailedAssistant)
	}
}

func TestActivityMappingPlanApprovalCompactionAndInterruption(t *testing.T) {
	at := "2026-01-01T00:00:00.000Z"
	thread := domain.CanonicalThread{Source: domain.SourceCodex, SourceKey: "codex:activities"}
	cases := []struct {
		activity domain.CanonicalActivity
		want     string
	}{
		{domain.CanonicalActivity{SourceID: "reason", Kind: "reasoning.summary", Tone: domain.ToneInfo, Summary: "think", Timestamp: at, Payload: map[string]any{}}, "reasoning"},
		{domain.CanonicalActivity{SourceID: "compact", Kind: "context-compaction", Tone: domain.ToneInfo, Summary: "compact", Timestamp: at, Payload: map[string]any{"beforeTokenCount": int64(10)}}, "compaction"},
		{domain.CanonicalActivity{SourceID: "approve", Kind: "tool.approval", Tone: domain.ToneApproval, Summary: "approve", Timestamp: at, Payload: map[string]any{"prompt": "Run?"}}, "approval_request"},
		{domain.CanonicalActivity{SourceID: "err", Kind: "provider.error", Tone: domain.ToneError, Summary: "oops", Timestamp: at, Payload: map[string]any{}}, "error"},
	}
	for _, tc := range cases {
		events, _ := activityEvents(thread, "t", tc.activity)
		if len(events) != 1 {
			t.Fatalf("%s event count=%d", tc.activity.Kind, len(events))
		}
		var p map[string]any
		_ = json.Unmarshal(events[0].Payload, &p)
		if p["type"] != tc.want {
			t.Fatalf("%s mapped to %v", tc.activity.Kind, p["type"])
		}
	}
	plan := domain.CanonicalActivity{SourceID: "plan", Kind: "turn.plan.updated", Tone: domain.ToneInfo, Timestamp: at, Payload: map[string]any{"plan": []any{map[string]any{"step": "write", "status": "pending"}}}}
	events, _ := activityEvents(thread, "t", plan)
	if len(events) != 2 || events[0].Type != "plan.updated" || events[1].Type != "turn-item.updated" {
		t.Fatalf("plan mapping: %+v", events)
	}
	var artifact map[string]any
	_ = json.Unmarshal(events[0].Payload, &artifact)
	if artifact["status"] != "active" {
		t.Fatalf("todo status %v", artifact["status"])
	}
	interrupted := domain.CanonicalTurn{ID: "turn", Status: domain.TurnInterrupted, TerminalReason: strPtr("stop"), User: domain.CanonicalMessage{SourceID: "u", Role: "user", Text: "x", Timestamp: at}}
	history, err := encodeHistory(domain.CanonicalThread{Source: domain.SourceCodex, SourceKey: "codex:interrupt", Turns: []domain.CanonicalTurn{interrupted}}, "t", "")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range history.Events {
		if e.Type == "turn-item.updated" {
			var p map[string]any
			_ = json.Unmarshal(e.Payload, &p)
			if p["type"] == "run_interrupt_result" && p["message"] == "stop" {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("interruption terminal item not encoded")
	}
}

func strPtr(s string) *string { return &s }
