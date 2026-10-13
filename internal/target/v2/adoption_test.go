package v2

import (
	"context"
	"testing"

	"github.com/CarlosGtrz/t3-import/internal/domain"
)

func TestMatchBuiltinCodexImportRequiresExactProjectedHistory(t *testing.T) {
	db := fixture(t)
	thread := builtinAdoptionThread(domain.SourceCodex)
	threadID := "import:codex:native-session"
	plan, err := BuildPlanWithRuntimeOptions(thread, threadID, "p-1", "codex", thread.Model, map[string]any{}, false, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = AppendPlan(context.Background(), db, plan); err != nil {
		t.Fatal(err)
	}
	before, err := Read(context.Background(), db, threadID)
	if err != nil {
		t.Fatal(err)
	}
	matched, err := MatchBuiltinImport(context.Background(), db, thread, []domain.CanonicalThread{thread}, "codex", "p-1", "")
	if err != nil {
		t.Fatalf("match exact built-in task: %v", err)
	}
	if matched.ThreadID != threadID || matched.ProviderThreadID == "" || matched.HeadEvent != nil {
		t.Fatalf("unexpected match: %+v", matched)
	}
	after, err := Read(context.Background(), db, threadID)
	if err != nil || len(before) != len(after) {
		t.Fatalf("read-only matcher changed history (before=%d after=%d err=%v)", len(before), len(after), err)
	}
	if _, err := db.Exec(`UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.text','edited') WHERE thread_id=? AND role='assistant'`, threadID); err != nil {
		t.Fatal(err)
	}
	if _, err := MatchBuiltinImport(context.Background(), db, thread, []domain.CanonicalThread{thread}, "codex", "p-1", ""); err == nil {
		t.Fatal("accepted a built-in task with changed message history")
	}
}

func TestMatchBuiltinClaudeImportPlansOwnedHeadAttachment(t *testing.T) {
	db := fixture(t)
	thread := builtinAdoptionThread(domain.SourceClaude)
	thread.SourceKey = "claude:native-session:leaf"
	thread.LeafID = stringPointer("leaf")
	thread.ResumeCursor = map[string]any{"resume": "native-session", "resumeSessionAt": "assistant-node", "turnCount": 1}
	thread.Turns[0].Assistant[0].SourceID = "assistant-node:text:0"
	threadID := "import:claudeAgent:native-session"
	plan, err := BuildPlanWithRuntimeOptions(thread, threadID, "p-1", "claudeAgent", thread.Model, map[string]any{}, false, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = AppendPlan(context.Background(), db, plan); err != nil {
		t.Fatal(err)
	}
	matched, err := MatchBuiltinImport(context.Background(), db, thread, []domain.CanonicalThread{thread}, "claudeAgent", "p-1", "")
	if err != nil {
		t.Fatalf("match exact Claude built-in task: %v", err)
	}
	if matched.ThreadID != threadID || matched.HeadEvent == nil || matched.HeadEvent.Type != "provider-thread.updated" || matched.HeadEvent.ID != BuiltinHeadEventID("claudeAgent", "native-session", thread.SourceKey, "assistant-node") {
		t.Fatalf("unexpected Claude head attachment: %+v", matched)
	}
}

func TestNativeExpectedClaudeTurnCollapsesAssistantBlocksByNode(t *testing.T) {
	thread := builtinAdoptionThread(domain.SourceClaude)
	thread.SourceKey = "claude:native-session:leaf"
	thread.LeafID = stringPointer("leaf")
	thread.ResumeCursor = map[string]any{"resume": "native-session", "resumeSessionAt": "assistant-node", "turnCount": 1}
	thread.Turns[0].Assistant = []domain.CanonicalMessage{
		{SourceID: "assistant-node:text:0", Role: "assistant", Text: "first ", Timestamp: "2026-01-01T00:00:01.000Z"},
		{SourceID: "assistant-node:text:1", Role: "assistant", Text: "second", Timestamp: "2026-01-01T00:00:02.000Z"},
	}
	plan, err := BuildPlanWithRuntimeOptions(thread, "thread-1", "project-1", "claudeAgent", thread.Model, map[string]any{}, false, "", true)
	if err != nil {
		t.Fatal(err)
	}
	threadEvents, err := planSourceTurn(thread, 0, plan, "")
	if err != nil {
		t.Fatal(err)
	}
	normalized, err := nativeExpectedTurnEvents(thread, thread.Turns[0], threadEvents)
	if err != nil {
		t.Fatal(err)
	}
	messages, items, _ := eventRows(normalized)
	if len(messages) != 2 || len(items) != 2 || messages[1]["text"] != "first second" || items[1]["text"] != "first second" {
		t.Fatalf("Claude assistant blocks were not collapsed: messages=%+v items=%+v", messages, items)
	}
}

func builtinAdoptionThread(source domain.SourceName) domain.CanonicalThread {
	at := "2026-01-01T00:00:00.000Z"
	thread := domain.CanonicalThread{
		Source: source, SourceSessionID: "native-session", SourceKey: string(source) + ":native-session",
		CurrentBranch: true, Title: "Adopted task", Workspace: "/work", Model: "model",
		CreatedAt: at, UpdatedAt: "2026-01-01T00:00:02.000Z", Warnings: []string{},
		ResumeCursor: map[string]any{"threadId": "native-session"},
		Turns: []domain.CanonicalTurn{{
			ID: "turn-1", StartedAt: at, CompletedAt: stringPointer("2026-01-01T00:00:02.000Z"),
			Status:     domain.TurnCompleted,
			User:       domain.CanonicalMessage{SourceID: "user-1", Role: "user", Text: "hello", Timestamp: at},
			Assistant:  []domain.CanonicalMessage{{SourceID: "assistant-1", Role: "assistant", Text: "world", Timestamp: "2026-01-01T00:00:01.000Z"}},
			Activities: []domain.CanonicalActivity{}, Plans: []domain.CanonicalPlan{},
		}},
	}
	return thread
}

func stringPointer(value string) *string { return &value }
