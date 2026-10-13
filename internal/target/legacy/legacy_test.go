package legacy

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/CarlosGtrz/t3-import/internal/checkpoint"
	"github.com/CarlosGtrz/t3-import/internal/domain"
)

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE effect_sql_migrations(migration_id INTEGER); INSERT INTO effect_sql_migrations VALUES(53);
CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE,aggregate_kind TEXT,stream_id TEXT,stream_version INTEGER,event_type TEXT,occurred_at TEXT,command_id TEXT,causation_event_id TEXT,correlation_id TEXT,actor_kind TEXT,payload_json TEXT,metadata_json TEXT,UNIQUE(aggregate_kind,stream_id,stream_version));
CREATE TABLE provider_session_runtime(thread_id TEXT PRIMARY KEY,provider_name TEXT NOT NULL,provider_instance_id TEXT,adapter_key TEXT NOT NULL,runtime_mode TEXT NOT NULL,status TEXT NOT NULL,last_seen_at TEXT NOT NULL,resume_cursor_json TEXT,runtime_payload_json TEXT);`)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func sample() domain.CanonicalThread {
	return domain.CanonicalThread{Source: domain.SourceCodex, SourceSessionID: "s", SourceKey: "codex:s", Title: "Task", CreatedAt: "2026-01-01T00:00:00.000Z", UpdatedAt: "2026-01-01T00:00:02.000Z", Turns: []domain.CanonicalTurn{{ID: "turn", StartedAt: "2026-01-01T00:00:00.000Z", Status: domain.TurnCompleted, User: domain.CanonicalMessage{SourceID: "u", Text: "hello", Timestamp: "2026-01-01T00:00:00.000Z"}, Assistant: []domain.CanonicalMessage{{SourceID: "a", Text: "hi", Timestamp: "2026-01-01T00:00:02.000Z"}}}}}
}

func TestPlanAndAppendLegacyEvents(t *testing.T) {
	db := testDB(t)
	plan := PlanImport(sample(), Target{ThreadID: "thread", ProjectID: "project", IdentitySeed: "codex:s"}, Provider{ProviderName: "codex", InstanceID: "codex", AdapterKey: "codex", Model: "test"}, true)
	if len(plan.Events) != 6 {
		t.Fatalf("event count=%d want 6", len(plan.Events))
	}
	first, last, err := Import(context.Background(), db, plan)
	if err != nil {
		t.Fatal(err)
	}
	if first != 1 || last != 6 {
		t.Fatalf("range %d..%d", first, last)
	}
	var typ, payload string
	if err := db.QueryRow("SELECT event_type,payload_json FROM orchestration_events WHERE sequence=1").Scan(&typ, &payload); err != nil {
		t.Fatal(err)
	}
	if typ != "thread.created" || payload == "" {
		t.Fatalf("unexpected first event %s %s", typ, payload)
	}
	priorEvent := Event{EventID: "new-before-failure", AggregateKind: "thread", StreamID: "other", Type: "thread.created", OccurredAt: sample().CreatedAt, ActorKind: "server", Payload: map[string]any{}, Metadata: map[string]any{}}
	duplicate := plan.Events[0]
	if _, _, err := Append(context.Background(), db, []Event{priorEvent, duplicate}); err == nil {
		t.Fatal("append with a later duplicate unexpectedly succeeded")
	}
	var count int
	_ = db.QueryRow("SELECT COUNT(*) FROM orchestration_events").Scan(&count)
	if count != 6 {
		t.Fatalf("failed append left partial rows: %d", count)
	}
}

func TestProjectIDsAttachmentsAndRuntimeBinding(t *testing.T) {
	thread := sample()
	remote := "https://example.test/image.png"
	thread.Turns[0].User.Attachments = []domain.SourceAttachment{{SourceID: "remote", Name: "image.png", MIMEType: "image/png", RemoteURL: &remote}}
	thread.ResumeCursor = map[string]any{"threadId": "native"}
	target := Target{ThreadID: ThreadID(thread), ProjectID: ProjectID("/work/project"), IdentitySeed: thread.SourceKey, Workspace: "/work/project", CreateProject: true}
	provider := Provider{ProviderName: "codex", InstanceID: "codex", AdapterKey: "codex", Model: "test"}
	plan := PlanImport(thread, target, provider, true)
	if plan.Events[0].Type != "project.created" {
		t.Fatalf("first event=%s", plan.Events[0].Type)
	}
	var body string
	for _, e := range plan.Events {
		if e.Type == "thread.message-sent" && e.Payload["role"] == "user" {
			body = e.Payload["text"].(string)
		}
	}
	if !strings.Contains(body, "[Attachment not imported: https://example.test/image.png]") {
		t.Fatalf("fallback attachment note missing: %q", body)
	}
	if _, _, err := Import(context.Background(), testDB(t), plan); err != nil {
		t.Fatal(err)
	}
}

func TestImportPersistsRuntimeAndSyncAppendsTurnOffset(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	base := sample()
	target := Target{ThreadID: "thread", ProjectID: "project", IdentitySeed: base.SourceKey}
	provider := Provider{ProviderName: "codex", InstanceID: "codex", AdapterKey: "codex", Model: "test"}
	base.ResumeCursor = map[string]any{"threadId": "source"}
	plan := PlanImport(base, target, provider, true)
	_, last, err := Import(ctx, db, plan)
	if err != nil {
		t.Fatal(err)
	}
	var status, cursor string
	if err := db.QueryRow("SELECT status,resume_cursor_json FROM provider_session_runtime WHERE thread_id='thread'").Scan(&status, &cursor); err != nil {
		t.Fatal(err)
	}
	if status != "stopped" || !strings.Contains(cursor, "source") {
		t.Fatalf("runtime=%s %s", status, cursor)
	}
	saved, err := checkpoint.ForThread(base)
	if err != nil {
		t.Fatal(err)
	}
	newer := base
	second := base.Turns[0]
	second.ID = "turn-2"
	second.StartedAt = "2026-01-01T00:00:03.000Z"
	second.User = domain.CanonicalMessage{SourceID: "u2", Text: "next", Timestamp: second.StartedAt}
	second.Assistant = []domain.CanonicalMessage{{SourceID: "a2", Text: "done", Timestamp: "2026-01-01T00:00:04.000Z"}}
	newer.Turns = append(append([]domain.CanonicalTurn{}, base.Turns...), second)
	result, err := SyncAppend(ctx, db, newer, target, provider, saved, last, true)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Appended || result.TurnsAdded != 1 {
		t.Fatalf("sync result=%+v", result)
	}
	var payload string
	if err := db.QueryRow("SELECT payload_json FROM orchestration_events WHERE event_type='thread.message-sent' AND json_extract(payload_json,'$.role')='user' ORDER BY sequence DESC LIMIT 1").Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(payload, "next") {
		t.Fatalf("new user event missing: %s", payload)
	}
	result, err = SyncAppend(ctx, db, newer, target, provider, saved, last, true)
	if err != nil || result.TurnsAdopted != 1 || result.TurnsAdded != 0 {
		t.Fatalf("sync did not adopt the exact complete provider suffix: %+v %v", result, err)
	}
}

func TestReplaceAtomicTombstonesAndRuntimeTransfer(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	old := PlanImport(sample(), Target{ThreadID: "old", IdentitySeed: "old"}, Provider{ProviderName: "codex", AdapterKey: "codex"}, false)
	if _, _, err := Import(ctx, db, old); err != nil {
		t.Fatal(err)
	}
	_, err := db.Exec(`INSERT INTO provider_session_runtime(thread_id,provider_name,provider_instance_id,adapter_key,runtime_mode,status,last_seen_at,resume_cursor_json,runtime_payload_json) VALUES('old','codex','i','codex','full-access','stopped','now','{}','{}')`)
	if err != nil {
		t.Fatal(err)
	}
	newPlan := PlanImport(sample(), Target{ThreadID: "new", IdentitySeed: "new"}, Provider{}, false)
	tomb := Event{EventID: "deleted", AggregateKind: "thread", StreamID: "old", Type: "thread.deleted", OccurredAt: "now", ActorKind: "client", Payload: map[string]any{"threadId": "old"}}
	if _, _, err = Replace(ctx, db, newPlan, []Event{tomb}); err != nil {
		t.Fatal(err)
	}
	var count int
	_ = db.QueryRow("SELECT COUNT(*) FROM orchestration_events WHERE stream_id='old' AND event_type='thread.deleted'").Scan(&count)
	if count != 1 {
		t.Fatalf("tombstones=%d", count)
	}
	_ = db.QueryRow("SELECT COUNT(*) FROM provider_session_runtime WHERE thread_id='new'").Scan(&count)
	if count != 1 {
		t.Fatal("runtime was not transferred")
	}
}

func TestReplaceRollbackOnInvalidTombstone(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	plan := PlanImport(sample(), Target{ThreadID: "new", IdentitySeed: "new"}, Provider{}, false)
	tomb := Event{EventID: "deleted", AggregateKind: "thread", StreamID: "missing", Type: "thread.deleted", OccurredAt: "now", ActorKind: "client", Payload: map[string]any{}}
	if _, _, err := Replace(ctx, db, plan, []Event{tomb}); err == nil {
		t.Fatal("replacement accepted missing old thread")
	}
	var count int
	_ = db.QueryRow("SELECT COUNT(*) FROM orchestration_events").Scan(&count)
	if count != 0 {
		t.Fatalf("failed replacement left %d new events", count)
	}
}

func TestSyncRejectsMismatchedAdoptionAndBatchRollsBack(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	base := sample()
	target := Target{ThreadID: "thread", IdentitySeed: base.SourceKey}
	provider := Provider{ProviderName: "codex", InstanceID: "codex", AdapterKey: "codex"}
	_, last, err := Import(ctx, db, PlanImport(base, target, provider, false))
	if err != nil {
		t.Fatal(err)
	}
	saved, err := checkpoint.ForThread(base)
	if err != nil {
		t.Fatal(err)
	}
	bad := base.Turns[0]
	bad.ID = "extra"
	bad.StartedAt = "2026-01-01T00:00:03.000Z"
	bad.Status = domain.TurnFailed
	bad.User = domain.CanonicalMessage{SourceID: "u2", Text: "second", Timestamp: bad.StartedAt}
	_, err = db.Exec(`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json) VALUES('suffix','thread','thread',6,'thread.session-set','now','provider','{"session":{"status":"ready"}}','{"providerTurnId":"extra"}')`)
	if err != nil {
		t.Fatal(err)
	}
	newer := base
	newer.Turns = append(append([]domain.CanonicalTurn{}, base.Turns...), bad)
	if _, err = SyncAppend(ctx, db, newer, target, provider, saved, last, false); err == nil {
		t.Fatal("sync accepted mismatched provider status")
	}
	second := PlanImport(base, Target{ThreadID: "other", IdentitySeed: "other"}, provider, false)
	if _, err = ImportBatch(ctx, db, []Plan{second, {}}); err == nil {
		t.Fatal("batch accepted empty plan")
	}
	var count int
	_ = db.QueryRow("SELECT COUNT(*) FROM orchestration_events WHERE stream_id='other'").Scan(&count)
	if count != 0 {
		t.Fatalf("failed batch left %d events", count)
	}
}

func TestPreviewAndMigration(t *testing.T) {
	db := testDB(t)
	target := Target{ThreadID: "thread", IdentitySeed: "codex:s"}
	p, err := PreviewImport(context.Background(), db, target, sample())
	if err != nil {
		t.Fatal(err)
	}
	if p.Migration != 53 || p.AlreadyImported || p.EventCount != 6 {
		t.Fatalf("preview=%+v", p)
	}
	_, _, err = Import(context.Background(), db, PlanImport(sample(), target, Provider{}, false))
	if err != nil {
		t.Fatal(err)
	}
	p, err = PreviewImport(context.Background(), db, target, sample())
	if err != nil {
		t.Fatal(err)
	}
	if !p.AlreadyImported {
		t.Fatal("expected imported marker")
	}
}
