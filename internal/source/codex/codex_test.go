package codex

import (
	"context"
	"github.com/CarlosGtrz/t3-import/internal/domain"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDiscoverAndLoadRollout(t *testing.T) {
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions", "2025", "01")
	if e := os.MkdirAll(sessions, 0755); e != nil {
		t.Fatal(e)
	}
	p := filepath.Join(sessions, "rollout.jsonl")
	data := `{"type":"session_meta","timestamp":"2025-01-01T00:00:00Z","payload":{"id":"abc123456789","cwd":"/work","timestamp":"2025-01-01T00:00:00Z"}}` + "\n" + `{"type":"event_msg","timestamp":"2025-01-01T00:00:01Z","payload":{"type":"task_started","turn_id":"t1"}}` + "\n" + `{"type":"response_item","timestamp":"2025-01-01T00:00:02Z","payload":{"type":"message","id":"u1","role":"user","content":[{"text":"hello"}]}}` + "\n" + `{"type":"response_item","timestamp":"2025-01-01T00:00:03Z","payload":{"type":"message","id":"a1","role":"assistant","content":[{"text":"world"}]}}` + "\n" + `{"type":"event_msg","timestamp":"2025-01-01T00:00:04Z","payload":{"type":"task_complete","turn_id":"t1"}}` + "\n"
	if e := os.WriteFile(p, []byte(data), 0600); e != nil {
		t.Fatal(e)
	}
	a := NewAt(root)
	got, e := a.DiscoverWithOutcomes(context.Background(), structOptions(time.Time{}))
	if e != nil {
		t.Fatal(e)
	}
	if len(got.Summaries) != 1 || len(got.Outcomes) != 0 {
		t.Fatalf("discover = %#v", got)
	}
	c, e := a.Load(context.Background(), got.Summaries[0], structOptions(time.Time{}))
	if e != nil {
		t.Fatal(e)
	}
	if len(c.Threads) != 1 || len(c.Threads[0].Turns) != 1 || c.Threads[0].Turns[0].User.Text != "hello" || c.Threads[0].Turns[0].Assistant[0].Text != "world" {
		t.Fatalf("conversation = %#v", c)
	}
}
func structOptions(_ time.Time) (o domain.DiscoveryOptions) { return }

func writeLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	if e := os.MkdirAll(filepath.Dir(path), 0755); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0600); e != nil {
		t.Fatal(e)
	}
}

func TestDiscoveryUsesIndexMetadataAndSince(t *testing.T) {
	root := t.TempDir()
	rollout := filepath.Join(root, "sessions", "x.jsonl")
	writeLines(t, rollout, `{"type":"session_meta","timestamp":"2025-01-01T00:00:00Z","payload":{"id":"idx-session","cwd":"/work","timestamp":"2025-01-01T00:00:00Z"}}`)
	writeLines(t, filepath.Join(root, "session_index.jsonl"), `{"id":"idx-session","thread_name":"Indexed title","updated_at":"2025-01-02T00:00:00Z"}`)
	a := NewAt(root)
	since := time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC)
	got, err := a.DiscoverWithOutcomes(context.Background(), domain.DiscoveryOptions{Since: &since})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Summaries) != 1 {
		t.Fatalf("index update should pass since filter: %#v", got.Summaries)
	}
	if got.Summaries[0].Title != "Indexed title" || got.Summaries[0].UpdatedAt != "2025-01-02T00:00:00Z" {
		t.Fatalf("index metadata not applied: %#v", got.Summaries[0])
	}
	later := time.Date(2025, 1, 3, 0, 0, 0, 0, time.UTC)
	got, err = a.DiscoverWithOutcomes(context.Background(), domain.DiscoveryOptions{Since: &later})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Summaries) != 0 {
		t.Fatalf("stale index entry passed since filter: %#v", got.Summaries)
	}
}

func TestLoadPreservesImagesAndSkipsManualContextHandoff(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "sessions", "images.jsonl")
	dataURL := "data:image/png;base64,aGVsbG8="
	writeLines(t, path,
		`{"type":"session_meta","timestamp":"2025-01-01T00:00:00Z","payload":{"id":"images","cwd":"/work","timestamp":"2025-01-01T00:00:00Z"}}`,
		`{"type":"response_item","timestamp":"2025-01-01T00:00:01Z","payload":{"type":"message","role":"user","content":[{"text":"Context handoff (manual_context):\nProvider context handoff. Thread: thread-1\nRecover omitted history using t3_thread_read(\"thread-1\")"}]}}`,
		`{"type":"event_msg","timestamp":"2025-01-01T00:00:02Z","payload":{"type":"task_started","turn_id":"t1"}}`,
		`{"type":"response_item","timestamp":"2025-01-01T00:00:03Z","payload":{"type":"message","id":"u1","role":"user","content":[{"text":"look"},{"image_url":"`+dataURL+`"},{"url":"https://example.test/image"}]}}`,
		`{"type":"event_msg","timestamp":"2025-01-01T00:00:04Z","payload":{"type":"task_complete","turn_id":"t1"}}`)
	a := NewAt(root)
	summary := domain.SourceSummary{Source: domain.SourceCodex, ID: "images", Path: path, Title: "Images"}
	c, err := a.Load(context.Background(), summary, domain.DiscoveryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	turn := c.Threads[0].Turns[0]
	if turn.User.Text != "look" || len(turn.User.Attachments) != 2 {
		t.Fatalf("user message: %#v", turn.User)
	}
	if turn.User.Attachments[0].MIMEType != "image/png" || string(turn.User.Attachments[0].Data.Data) != "hello" {
		t.Fatalf("embedded image: %#v", turn.User.Attachments[0])
	}
	if turn.User.Attachments[1].RemoteURL == nil || *turn.User.Attachments[1].RemoteURL != "https://example.test/image" {
		t.Fatalf("remote image: %#v", turn.User.Attachments[1])
	}
}

func TestLoadDistinguishesNonStatusCodexErrors(t *testing.T) {
	for _, tc := range []struct {
		name, kind string
		want       domain.TurnStatus
	}{{"rollback", "thread_rollback_failed", domain.TurnInProgress}, {"active-turn", "active_turn_not_steerable", domain.TurnInProgress}, {"provider", "quota_exceeded", domain.TurnFailed}} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "sessions", "error.jsonl")
			writeLines(t, path,
				`{"type":"session_meta","timestamp":"2025-01-01T00:00:00Z","payload":{"id":"err","cwd":"/work"}}`,
				`{"type":"event_msg","timestamp":"2025-01-01T00:00:01Z","payload":{"type":"task_started","turn_id":"t1"}}`,
				`{"type":"response_item","timestamp":"2025-01-01T00:00:02Z","payload":{"type":"message","role":"user","content":[{"text":"hello"}]}}`,
				`{"type":"event_msg","timestamp":"2025-01-01T00:00:03Z","payload":{"type":"error","turn_id":"t1","message":"failure","codex_error_info":{"type":"`+tc.kind+`"}}}`)
			include := true
			c, err := NewAt(root).Load(context.Background(), domain.SourceSummary{Source: domain.SourceCodex, ID: "err", Path: path}, domain.DiscoveryOptions{IncludeIncomplete: &include})
			if err != nil {
				t.Fatal(err)
			}
			if got := c.Threads[0].Turns[0].Status; got != tc.want {
				t.Fatalf("status=%s, want %s", got, tc.want)
			}
			if len(c.Threads[0].Turns[0].Activities) != 1 {
				t.Fatalf("provider error activity missing: %#v", c.Threads[0].Turns[0].Activities)
			}
		})
	}
}

func TestLoadMapsCodexHistoryActivities(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "sessions", "activities.jsonl")
	writeLines(t, path,
		`{"type":"session_meta","timestamp":"2025-01-01T00:00:00Z","payload":{"id":"activities","cwd":"/work"}}`,
		`{"type":"event_msg","timestamp":"2025-01-01T00:00:01Z","payload":{"type":"task_started","turn_id":"t1"}}`,
		`{"type":"response_item","timestamp":"2025-01-01T00:00:02Z","payload":{"type":"message","role":"user","content":[{"text":"hello"}]}}`,
		`{"type":"response_item","timestamp":"2025-01-01T00:00:03Z","payload":{"type":"reasoning","id":"reason-1","summary":[{"text":"Thought one"},{"text":"Thought two"}]}}`,
		`{"type":"event_msg","timestamp":"2025-01-01T00:00:04Z","payload":{"type":"agent_reasoning","text":"More reasoning"}}`,
		`{"type":"event_msg","timestamp":"2025-01-01T00:00:05Z","payload":{"type":"context_compaction"}}`,
		`{"type":"event_msg","timestamp":"2025-01-01T00:00:06Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3,"reasoning_output_tokens":1,"total_tokens":13},"total_token_usage":{"total_tokens":20},"model_context_window":1000}}}`,
		`{"type":"event_msg","timestamp":"2025-01-01T00:00:07Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3,"reasoning_output_tokens":1,"total_tokens":13},"total_token_usage":{"total_tokens":20},"model_context_window":1000}}}`,
		`{"type":"response_item","timestamp":"2025-01-01T00:00:08Z","payload":{"type":"custom_tool_call","call_id":"mcp1","name":"mcp__search","input":"{\"query\":\"x\"}"}}`,
		`{"type":"response_item","timestamp":"2025-01-01T00:00:09Z","payload":{"type":"custom_tool_call_output","call_id":"mcp1","output":{"is_error":true,"text":"denied"}}}`,
		`{"type":"event_msg","timestamp":"2025-01-01T00:00:10Z","payload":{"type":"patch_apply_end","success":false}}`,
		`{"type":"response_item","timestamp":"2025-01-01T00:00:11Z","payload":{"type":"custom_tool_call","call_id":"agent1","name":"spawn_agent","input":"{\"task_name\":\"Inspect parser\",\"role\":\"reviewer\"}"}}`,
		`{"type":"response_item","timestamp":"2025-01-01T00:00:12Z","payload":{"type":"custom_tool_call_output","call_id":"agent1","output":{"success":false,"text":"failed"}}}`,
		`{"type":"response_item","timestamp":"2025-01-01T00:00:13Z","payload":{"type":"custom_tool_call","call_id":"plan1","name":"update_plan","input":"{\"explanation\":\"progress\",\"plan\":[{\"step\":\"parse\",\"status\":\"completed\"}]}"}}`,
		`{"type":"event_msg","timestamp":"2025-01-01T00:00:14Z","payload":{"type":"task_complete","turn_id":"t1"}}`,
	)
	include := true
	conversation, err := NewAt(root).Load(context.Background(), domain.SourceSummary{Source: domain.SourceCodex, ID: "activities", Path: path}, domain.DiscoveryOptions{IncludeIncomplete: &include})
	if err != nil {
		t.Fatal(err)
	}
	activities := conversation.Threads[0].Turns[0].Activities
	count := func(kind string) int {
		n := 0
		for _, a := range activities {
			if a.Kind == kind {
				n++
			}
		}
		return n
	}
	if count("reasoning.summary") != 2 || count("context-compaction") != 1 || count("context-window.updated") != 1 || count("tool.completed") != 3 || count("task.started") != 1 || count("task.updated") != 1 || count("turn.plan.updated") != 1 {
		t.Fatalf("activities = %#v", activities)
	}
	bySource := map[string]domain.CanonicalActivity{}
	for _, a := range activities {
		bySource[a.SourceID] = a
	}
	if got := bySource["reason-1"].Payload["detail"]; got != "Thought one\nThought two" {
		t.Fatalf("reasoning detail = %#v", got)
	}
	if got := bySource["usage:7"].Payload["totalProcessedTokens"]; got != 20 {
		t.Fatalf("usage payload = %#v", bySource["usage:7"].Payload)
	}
	if bySource["mcp1"].Payload["itemType"] != "mcp_tool_call" || bySource["mcp1"].Payload["status"] != "failed" || bySource["mcp1"].Tone != domain.ToneError {
		t.Fatalf("failed MCP tool = %#v", bySource["mcp1"])
	}
	var patch, plan, taskStart, taskFinish bool
	for _, a := range activities {
		switch a.Kind {
		case "tool.completed":
			if a.SourceID == "event:11" && a.Payload["itemType"] == "file_change" && a.Payload["status"] == "failed" {
				patch = true
			}
		case "turn.plan.updated":
			if a.Payload["explanation"] == "progress" {
				plan = true
			}
		case "task.started":
			if a.Payload["title"] == "Inspect parser" && a.Payload["role"] == "reviewer" {
				taskStart = true
			}
		case "task.updated":
			if a.Payload["status"] == "failed" {
				taskFinish = true
			}
		}
	}
	if !patch || !plan || !taskStart || !taskFinish {
		t.Fatalf("patch=%v plan=%v taskStart=%v taskFinish=%v activities=%#v", patch, plan, taskStart, taskFinish, activities)
	}
}
