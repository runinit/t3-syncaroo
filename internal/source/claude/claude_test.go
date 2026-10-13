package claude

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CarlosGtrz/t3-import/internal/domain"
)

func writeRows(t *testing.T, path string, rows ...map[string]any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	f, e := os.Create(path)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	for _, r := range rows {
		b, _ := json.Marshal(r)
		_, _ = f.Write(append(b, '\n'))
	}
}

func TestReadRejectsMalformedJSONL(t *testing.T) {
	p := filepath.Join(t.TempDir(), "bad.jsonl")
	if err := os.WriteFile(p, []byte(`{"type":"user"}`+"\nnot json\n"), 0600); err != nil {
		t.Fatal(err)
	}
	_, _, err := read(p)
	if err == nil || !strings.Contains(err.Error(), "malformed Claude JSONL") {
		t.Fatalf("expected malformed JSONL error, got %v", err)
	}
}

func TestRetryAndCompactionRelinkingAreCycleGuarded(t *testing.T) {
	rows := []map[string]any{
		{"sessionId": "s", "cwd": "/w", "uuid": "u", "type": "user", "timestamp": "2025-01-01T00:00:00Z", "message": map[string]any{"content": "prompt"}},
		{"uuid": "err", "parentUuid": "u", "type": "system", "subtype": "api_error", "retryAttempt": float64(1), "maxRetries": float64(3), "timestamp": "2025-01-01T00:00:01Z"},
		{"uuid": "retry", "parentUuid": "u", "type": "assistant", "timestamp": "2025-01-01T00:00:02Z", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "answer"}}, "stop_reason": "end_turn"}},
		{"uuid": "next", "parentUuid": "err", "type": "user", "timestamp": "2025-01-01T00:00:03Z", "message": map[string]any{"content": "next"}},
		{"uuid": "compact", "type": "system", "subtype": "compact_boundary", "timestamp": "2025-01-01T00:00:04Z", "logicalParentUuid": "next"},
		{"uuid": "cycle", "type": "system", "subtype": "compact_boundary", "timestamp": "2025-01-01T00:00:05Z", "logicalParentUuid": "cycle"},
	}
	m, err := analyze(rows, "2025-01-01T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if m.nodes["retry"].parent != "err" || m.nodes["next"].parent != "retry" {
		t.Fatalf("retry graph not reconnected: retry=%q next=%q", m.nodes["retry"].parent, m.nodes["next"].parent)
	}
	if m.nodes["compact"].parent != "next" {
		t.Fatalf("compact boundary parent = %q", m.nodes["compact"].parent)
	}
	if m.nodes["cycle"].parent != "" {
		t.Fatalf("cycle compact boundary was linked: %q", m.nodes["cycle"].parent)
	}
}

func TestFailedToolResultAndUsageArePreserved(t *testing.T) {
	rows := []map[string]any{
		{"sessionId": "s", "cwd": "/w", "uuid": "u", "type": "user", "timestamp": "2025-01-01T00:00:00Z", "message": map[string]any{"content": "run"}},
		{"uuid": "a", "parentUuid": "u", "type": "assistant", "timestamp": "2025-01-01T00:00:01Z", "message": map[string]any{"usage": map[string]any{"input_tokens": float64(7), "output_tokens": float64(2), "cache_read_input_tokens": float64(3)}, "content": []any{map[string]any{"type": "tool_use", "id": "c", "name": "Bash", "input": map[string]any{"command": "false"}}}, "stop_reason": "end_turn"}},
		{"uuid": "r", "parentUuid": "a", "type": "user", "timestamp": "2025-01-01T00:00:02Z", "message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "tool_use_id": "c", "is_error": true, "content": "failed"}}}},
		{"uuid": "a2", "parentUuid": "r", "type": "assistant", "timestamp": "2025-01-01T00:00:03Z", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "done"}}, "stop_reason": "end_turn"}},
	}
	m, err := analyze(rows, "2025-01-01T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	thread := build(m, m.leaves[0], 0)
	turn := thread.Turns[0]
	foundTool, foundUsage := false, false
	for _, act := range turn.Activities {
		if act.Kind == "tool.completed" {
			foundTool = true
			if act.Tone != domain.ToneError || act.Payload["status"] != "failed" {
				t.Fatalf("tool failure lost: %#v", act)
			}
		}
		if act.Kind == "context-window.updated" {
			foundUsage = true
			if act.Payload["usedTokens"] != int64(12) {
				t.Fatalf("usage incorrect: %#v", act.Payload)
			}
		}
	}
	if !foundTool || !foundUsage {
		t.Fatalf("missing activities: %#v", turn.Activities)
	}
}

func TestClaudeTurnActivitiesAndControlFailureSemantics(t *testing.T) {
	base := "2025-01-01T00:00:"
	rows := []map[string]any{
		{"sessionId": "s", "cwd": "/w", "uuid": "u1", "type": "user", "timestamp": base + "00Z", "message": map[string]any{"content": "truncate"}},
		{"uuid": "a1", "parentUuid": "u1", "type": "assistant", "timestamp": base + "01Z", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "partial"}}, "stop_reason": "max_tokens"}},
		{"uuid": "u2", "parentUuid": "a1", "type": "user", "timestamp": base + "02Z", "message": map[string]any{"content": "refuse"}},
		{"uuid": "a2", "parentUuid": "u2", "type": "assistant", "timestamp": base + "03Z", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "no"}}, "stop_reason": "refusal"}},
		{"uuid": "u3", "parentUuid": "a2", "type": "user", "timestamp": base + "04Z", "message": map[string]any{"content": "overflow"}},
		{"uuid": "a3", "parentUuid": "u3", "type": "assistant", "timestamp": base + "05Z", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "too large"}}, "stop_reason": "context_window_exceeded"}},
		{"uuid": "u4", "parentUuid": "a3", "type": "user", "timestamp": base + "06Z", "message": map[string]any{"content": "plan and delegate"}},
		{"uuid": "a4", "parentUuid": "u4", "type": "assistant", "timestamp": base + "07Z", "message": map[string]any{"content": []any{
			map[string]any{"type": "tool_use", "id": "todo", "name": "TodoWrite", "input": map[string]any{"todos": []any{map[string]any{"content": "Do work", "status": "in_progress"}}}},
			map[string]any{"type": "tool_use", "id": "agent", "name": "Task", "input": map[string]any{"description": "Inspect branch", "subagent_type": "explorer"}},
			map[string]any{"type": "text", "text": "working"},
		}, "stop_reason": "tool_use"}},
		{"uuid": "bad", "parentUuid": "a4", "type": "result", "subtype": "error_during_execution", "is_error": true, "result": "execution broke", "timestamp": base + "08Z"},
		{"uuid": "u5", "parentUuid": "bad", "type": "user", "timestamp": base + "09Z", "message": map[string]any{"content": "continue"}},
		{"uuid": "a5", "parentUuid": "u5", "type": "assistant", "timestamp": base + "10Z", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "done"}}, "stop_reason": "end_turn"}},
	}
	m, err := analyze(rows, base+"00Z")
	if err != nil {
		t.Fatal(err)
	}
	th := build(m, m.leaves[0], 0)
	if len(th.Turns) != 5 {
		t.Fatalf("turns=%d %#v", len(th.Turns), th.Turns)
	}
	if th.Turns[0].Status != domain.TurnInterrupted || !hasActivity(th.Turns[0], "turn.interrupted") {
		t.Fatalf("truncation lost: %#v", th.Turns[0])
	}
	if th.Turns[1].Status != domain.TurnCompleted || !hasActivity(th.Turns[1], "provider.refusal") {
		t.Fatalf("refusal lost: %#v", th.Turns[1])
	}
	if th.Turns[2].Status != domain.TurnFailed || !hasActivity(th.Turns[2], "turn.failed") {
		t.Fatalf("context failure lost: %#v", th.Turns[2])
	}
	var sawPlan, sawStarted, sawUpdated bool
	for _, a := range th.Turns[3].Activities {
		switch a.Kind {
		case "turn.plan.updated":
			sawPlan = true
		case "task.started":
			sawStarted = true
		case "task.updated":
			sawUpdated = true
		}
	}
	if !sawPlan || !sawStarted || !sawUpdated {
		t.Fatalf("plan or agent lifecycle missing: %#v", th.Turns[3].Activities)
	}
	if th.Turns[3].Status != domain.TurnFailed || th.Turns[3].TerminalReason == nil || *th.Turns[3].TerminalReason != "error_during_execution" || th.Turns[3].TerminalError == nil || *th.Turns[3].TerminalError != "execution broke" {
		t.Fatalf("control failure lost: %#v", th.Turns[3])
	}
}
func hasActivity(t domain.CanonicalTurn, kind string) bool {
	for _, a := range t.Activities {
		if a.Kind == kind {
			return true
		}
	}
	return false
}
func TestDiscoverAndLoadGraphAttachmentAndIncompleteFiltering(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "projects", "p", "s.jsonl")
	writeRows(t, path,
		map[string]any{"sessionId": "sess", "cwd": "/work", "uuid": "u1", "type": "user", "timestamp": "2025-01-01T00:00:00Z", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "Look"}, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png", "data": "AQID"}}}}},
		map[string]any{"sessionId": "sess", "uuid": "a1", "parentUuid": "u1", "type": "assistant", "timestamp": "2025-01-01T00:00:01Z", "message": map[string]any{"model": "claude-test", "content": []any{map[string]any{"type": "text", "text": "Found it"}}, "stop_reason": "end_turn"}},
		map[string]any{"sessionId": "sess", "uuid": "u2", "parentUuid": "a1", "type": "user", "timestamp": "2025-01-01T00:00:02Z", "message": map[string]any{"content": "still working"}},
	)
	a := New(root)
	got, e := a.DiscoverWithOutcomes(context.Background(), domain.DiscoveryOptions{})
	if e != nil {
		t.Fatal(e)
	}
	if len(got.Summaries) != 1 || got.Summaries[0].Branches != 1 {
		t.Fatalf("summaries: %#v", got.Summaries)
	}
	c, e := a.Load(context.Background(), got.Summaries[0], domain.DiscoveryOptions{})
	if e != nil {
		t.Fatal(e)
	}
	if len(c.Threads) != 1 || len(c.Threads[0].Turns) != 1 || c.Threads[0].IgnoredInProgressTurns == nil || *c.Threads[0].IgnoredInProgressTurns != 1 {
		t.Fatalf("filtered conversation: %#v", c.Threads)
	}
	u := c.Threads[0].Turns[0].User
	if u.Text != "Look" || len(u.Attachments) != 1 || u.Attachments[0].SizeBytes != 3 {
		t.Fatalf("user attachment: %#v", u)
	}
	include := true
	c, e = a.Load(context.Background(), got.Summaries[0], domain.DiscoveryOptions{IncludeIncomplete: &include})
	if e != nil {
		t.Fatal(e)
	}
	if len(c.Threads[0].Turns) != 2 || c.Threads[0].Turns[1].Status != domain.TurnInProgress {
		t.Fatalf("included incomplete: %#v", c.Threads[0].Turns)
	}
}
func TestSidechainOnlyReportedUnsupported(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "projects", "p", "sub.jsonl")
	writeRows(t, path, map[string]any{"sessionId": "sess", "cwd": "/work", "uuid": "x", "type": "assistant", "isSidechain": true, "timestamp": "2025-01-01T00:00:00Z", "message": map[string]any{"content": "hidden"}})
	r, e := New(root).DiscoverWithOutcomes(context.Background(), domain.DiscoveryOptions{})
	if e != nil {
		t.Fatal(e)
	}
	if len(r.Summaries) != 0 || len(r.Outcomes) != 1 || r.Outcomes[0].Outcome.Code != "claude-sidechain-session" {
		t.Fatalf("result: %#v", r)
	}
}
