// Package codex imports Codex rollout JSONL transcripts.
package codex

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/CarlosGtrz/t3-import/internal/domain"
)

type Adapter struct{ root string }

func New() *Adapter {
	root := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if root == "" {
		if u, e := user.Current(); e == nil {
			root = filepath.Join(u.HomeDir, ".codex")
		}
	}
	return &Adapter{root: root}
}
func NewAt(root string) *Adapter           { return &Adapter{root: root} }
func (a *Adapter) Name() domain.SourceName { return domain.SourceCodex }

type row struct {
	Type       string         `json:"type"`
	Timestamp  any            `json:"timestamp"`
	Payload    map[string]any `json:"payload"`
	ID         string         `json:"id"`
	ThreadName string         `json:"thread_name"`
	UpdatedAt  any            `json:"updated_at"`
}

func str(v any) string { s, _ := v.(string); return s }
func errorMessage(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if m, ok := v.(map[string]any); ok {
		for _, k := range []string{"message", "error", "type"} {
			if s := str(m[k]); s != "" {
				return s
			}
		}
	}
	return ""
}
func stamp(v any, fallback string) string {
	if s, ok := v.(string); ok {
		if t, e := time.Parse(time.RFC3339Nano, s); e == nil {
			return t.UTC().Format(time.RFC3339Nano)
		}
	}
	if n, ok := v.(float64); ok {
		if n < 10_000_000_000 {
			return time.UnixMilli(int64(n * 1000)).UTC().Format(time.RFC3339Nano)
		}
		return time.UnixMilli(int64(n)).UTC().Format(time.RFC3339Nano)
	}
	return fallback
}
func canonical(path string) string {
	p, e := filepath.Abs(path)
	if e != nil {
		return filepath.Clean(path)
	}
	if q, e := filepath.EvalSymlinks(p); e == nil {
		return q
	}
	return filepath.Clean(p)
}
func (a *Adapter) files() ([]string, []string) {
	var files, failures []string
	root := filepath.Join(a.root, "sessions")
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, e error) error {
		if e != nil {
			failures = append(failures, p)
			return nil
		}
		if !d.IsDir() && strings.HasSuffix(d.Name(), ".jsonl") {
			files = append(files, p)
		}
		return nil
	})
	return files, failures
}
func read(path string) ([]row, string, time.Time, error) {
	f, e := os.Open(path)
	if e != nil {
		return nil, "", time.Time{}, e
	}
	defer f.Close()
	before, e := f.Stat()
	if e != nil {
		return nil, "", time.Time{}, e
	}
	h := sha256.New()
	rows := []row{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		_, _ = io.WriteString(h, line+"\n")
		var r row
		if e = json.Unmarshal([]byte(line), &r); e != nil {
			return nil, "", time.Time{}, fmt.Errorf("invalid JSONL: %w", e)
		}
		rows = append(rows, r)
	}
	if e = sc.Err(); e != nil {
		return nil, "", time.Time{}, e
	}
	after, e := f.Stat()
	if e != nil {
		return nil, "", time.Time{}, e
	}
	if before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		return nil, "", time.Time{}, fmt.Errorf("SOURCE_CHANGED_DURING_READ")
	}
	return rows, hex.EncodeToString(h.Sum(nil)), after.ModTime(), nil
}
func (a *Adapter) Discover(ctx context.Context, o domain.DiscoveryOptions) ([]domain.SourceSummary, error) {
	r, e := a.DiscoverWithOutcomes(ctx, o)
	return r.Summaries, e
}
func (a *Adapter) DiscoverWithOutcomes(ctx context.Context, o domain.DiscoveryOptions) (domain.SourceDiscoveryResult, error) {
	out := domain.SourceDiscoveryResult{Summaries: []domain.SourceSummary{}, Outcomes: []domain.SessionOutcomeRecord{}}
	indexedTitles, indexedUpdates := map[string]string{}, map[string]string{}
	if indexRows, _, _, err := read(filepath.Join(a.root, "session_index.jsonl")); err == nil {
		for _, r := range indexRows {
			id, title := r.ID, r.ThreadName
			if id != "" && title != "" {
				indexedTitles[id] = title
			}
			if id != "" && r.UpdatedAt != nil {
				indexedUpdates[id] = stamp(r.UpdatedAt, "")
			}
		}
	}
	files, failures := a.files()
	for _, p := range failures {
		out.Outcomes = append(out.Outcomes, outcome(p, "source-scan-failed", "failed", "", ""))
	}
	for _, p := range files {
		select {
		case <-ctx.Done():
			return out, ctx.Err()
		default:
		}
		rows, _, mt, e := read(p)
		if e != nil {
			code := "source-unreadable"
			if strings.Contains(e.Error(), "SOURCE_CHANGED") {
				code = "source-changed-during-read"
			}
			out.Outcomes = append(out.Outcomes, outcome(p, code, "failed", "", ""))
			continue
		}
		var id, ws, created, threadSource string
		for _, r := range rows {
			if r.Type == "session_meta" {
				id = str(r.Payload["id"])
				if id == "" {
					id = str(r.Payload["session_id"])
				}
				ws = str(r.Payload["cwd"])
				created = stamp(r.Payload["timestamp"], stamp(r.Timestamp, mt.UTC().Format(time.RFC3339Nano)))
				threadSource = str(r.Payload["thread_source"])
				break
			}
		}
		if id == "" || ws == "" {
			out.Outcomes = append(out.Outcomes, outcome(p, "unsupported-session-format", "unsupported", "", ""))
			continue
		}
		if o.Workspace != nil && canonical(ws) != canonical(*o.Workspace) {
			continue
		}
		updated := mt.UTC().Format(time.RFC3339Nano)
		if indexedUpdates[id] != "" {
			updated = indexedUpdates[id]
		}
		if o.Since != nil {
			t, err := time.Parse(time.RFC3339Nano, updated)
			if err == nil && t.Before(*o.Since) {
				continue
			}
		}
		if threadSource != "" && threadSource != "user" {
			out.Outcomes = append(out.Outcomes, outcome(p, "child-session-contained-by-parent", "deferred", id, ws))
			continue
		}
		title := indexedTitles[id]
		if title == "" {
			title = "Codex conversation " + short(id)
		}
		out.Summaries = append(out.Summaries, domain.SourceSummary{Source: domain.SourceCodex, ID: id, Title: title, Workspace: ws, Path: p, CreatedAt: created, UpdatedAt: updated, Status: domain.SummaryComplete, Branches: 1})
	}
	sort.Slice(out.Summaries, func(i, j int) bool { return out.Summaries[i].UpdatedAt > out.Summaries[j].UpdatedAt })
	// App-server metadata is optional enrichment; cap the whole lookup so a
	// missing or wedged Codex binary cannot delay discovery indefinitely.
	appCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	metadata, appErr := listAppThreads(appCtx, func() string {
		if o.Workspace != nil {
			return *o.Workspace
		}
		return ""
	}())
	cancel()
	if appErr == nil {
		filtered := out.Summaries[:0]
		for _, s := range out.Summaries {
			m := metadata[s.ID]
			if m == nil {
				filtered = append(filtered, s)
				continue
			}
			if name, ok := m["name"].(string); ok && strings.TrimSpace(name) != "" {
				s.Title = name
			} else if preview, ok := m["preview"].(string); ok && strings.TrimSpace(preview) != "" {
				s.Title = preview
			}
			if parent, ok := m["parentThreadId"].(string); ok && parent != "" {
				out.Outcomes = append(out.Outcomes, outcome(s.Path, "child-session-contained-by-parent", "deferred", s.ID, s.Workspace))
				continue
			}
			if n, ok := m["updatedAt"].(float64); ok {
				s.UpdatedAt = appTimestamp(n, s.UpdatedAt)
			}
			filtered = append(filtered, s)
		}
		out.Summaries = filtered
		sort.Slice(out.Summaries, func(i, j int) bool { return out.Summaries[i].UpdatedAt > out.Summaries[j].UpdatedAt })
	}
	return out, nil
}

func appTimestamp(n float64, fallback string) string {
	if n < 1e12 {
		n *= 1000
	}
	return time.UnixMilli(int64(n)).UTC().Format(time.RFC3339Nano)
}
func short(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	return s
}
func outcome(p, code, kind, id, ws string) domain.SessionOutcomeRecord {
	k := domain.OutcomeFailed
	if kind == "unsupported" {
		k = domain.OutcomeUnsupported
	}
	if kind == "deferred" {
		k = domain.OutcomeDeferred
	}
	message, next := "The source transcript could not be read or parsed.", "Check that the transcript is readable JSONL and unchanged, then rediscover."
	if code == "unsupported-session-format" {
		message = "The file does not contain a supported Codex session header."
		next = "Verify this is a Codex session file with a readable session header, then rediscover."
	}
	var sid, w *string
	if id != "" {
		sid = &id
	}
	if ws != "" {
		w = &ws
	}
	return domain.SessionOutcomeRecord{Source: domain.SourceCodex, SessionID: sid, Workspace: w, SourcePath: &p, DisplayName: filepath.Base(p), Outcome: domain.SessionOutcome{Kind: k, Phase: domain.PhaseDiscovery, Code: code, Message: message, NextAction: next}}
}

type pending struct {
	id, started, completed, status string
	users, assistant               []domain.CanonicalMessage
	activities                     []domain.CanonicalActivity
	plans                          []domain.CanonicalPlan
	calls                          map[string]map[string]any
	reason, err                    string
}

func manualContextHandoff(text string) bool {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	if len(lines) < 2 || lines[0] != "Context handoff (manual_context):" || !strings.HasPrefix(lines[1], "Provider context handoff. Thread: ") {
		return false
	}
	if strings.TrimSpace(strings.TrimPrefix(lines[1], "Provider context handoff. Thread: ")) == "" {
		return false
	}
	for _, line := range lines {
		if strings.HasPrefix(line, "Recover omitted history using t3_thread_read(") {
			return true
		}
	}
	return false
}

func statusAffectingError(payload map[string]any) bool {
	info, _ := payload["codex_error_info"].(map[string]any)
	if info == nil {
		info, _ = payload["error_info"].(map[string]any)
	}
	kind := str(info["type"])
	if kind == "" {
		kind = str(info["kind"])
	}
	if kind == "" {
		kind = str(payload["error_type"])
	}
	return kind != "thread_rollback_failed" && kind != "active_turn_not_steerable"
}

func parseImageAttachments(content []any, role string, record int) []domain.SourceAttachment {
	if role != "user" {
		return []domain.SourceAttachment{}
	}
	out := []domain.SourceAttachment{}
	for i, part := range content {
		m, ok := part.(map[string]any)
		if !ok {
			continue
		}
		url := str(m["image_url"])
		if url == "" {
			url = str(m["url"])
		}
		if url == "" {
			continue
		}
		a := domain.SourceAttachment{SourceID: fmt.Sprintf("%d:image:%d", record, i), Name: fmt.Sprintf("image-%d", i+1), MIMEType: "image/unknown", SizeBytes: 0}
		if strings.HasPrefix(strings.ToLower(url), "data:image/") {
			comma := strings.IndexByte(url, ',')
			if comma < 0 {
				continue
			}
			header := url[:comma]
			if !strings.Contains(strings.ToLower(header), ";base64") {
				continue
			}
			mime := strings.TrimPrefix(strings.SplitN(header, ";", 2)[0], "data:")
			data, err := base64.StdEncoding.DecodeString(url[comma+1:])
			if err != nil {
				continue
			}
			a.MIMEType = mime
			a.SizeBytes = int64(len(data))
			b := domain.Buffer{Data: data}
			a.Data = &b
		} else {
			a.RemoteURL = &url
		}
		out = append(out, a)
	}
	return out
}

func truncate(s string, limit int) string {
	s = strings.TrimSpace(s)
	if len(s) > limit {
		return s[:limit-1] + "…"
	}
	return s
}
func parseInput(v any) any {
	s, ok := v.(string)
	if !ok {
		return v
	}
	var parsed any
	if json.Unmarshal([]byte(s), &parsed) == nil {
		return parsed
	}
	return v
}
func contentString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []any:
		var parts []string
		for _, p := range x {
			if s, ok := p.(string); ok {
				parts = append(parts, s)
			} else if m, ok := p.(map[string]any); ok && str(m["text"]) != "" {
				parts = append(parts, str(m["text"]))
			}
		}
		return strings.TrimSpace(strings.Join(parts, "\n"))
	case nil:
		return ""
	default:
		b, e := json.Marshal(v)
		if e != nil {
			return ""
		}
		return string(b)
	}
}
func reasoningText(p map[string]any) string {
	for _, key := range []string{"text", "message", "reasoning"} {
		if s := str(p[key]); strings.TrimSpace(s) != "" {
			return s
		}
	}
	if entries, ok := p["summary"].([]any); ok {
		var lines []string
		for _, entry := range entries {
			if m, ok := entry.(map[string]any); ok && str(m["text"]) != "" {
				lines = append(lines, str(m["text"]))
			}
		}
		return strings.TrimSpace(strings.Join(lines, "\n"))
	}
	return ""
}
func classifyTool(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "mcp"):
		return "mcp_tool_call"
	case strings.Contains(n, "web") || strings.Contains(n, "search"):
		return "web_search"
	case strings.Contains(n, "image") || strings.Contains(n, "view"):
		return "image_view"
	case strings.Contains(n, "patch") || strings.Contains(n, "edit") || strings.Contains(n, "write"):
		return "file_change"
	case strings.Contains(n, "shell") || strings.Contains(n, "exec") || strings.Contains(n, "command"):
		return "command_execution"
	case strings.Contains(n, "agent") || strings.Contains(n, "collab"):
		return "collab_agent_tool_call"
	default:
		return "dynamic_tool_call"
	}
}
func usageActivity(info map[string]any, id, timestamp string) *domain.CanonicalActivity {
	last, ok := info["last_token_usage"].(map[string]any)
	if !ok {
		return nil
	}
	number := func(m map[string]any, key string) (int, bool) {
		n, ok := m[key].(float64)
		if !ok || n < 0 {
			return 0, false
		}
		return int(n), true
	}
	used, ok := number(last, "total_tokens")
	if !ok || used <= 0 {
		return nil
	}
	payload := map[string]any{"usedTokens": used, "lastUsedTokens": used, "compactsAutomatically": true}
	if n, ok := number(last, "input_tokens"); ok {
		payload["inputTokens"] = n
		payload["lastInputTokens"] = n
	}
	if n, ok := number(last, "cached_input_tokens"); ok {
		payload["cachedInputTokens"] = n
		payload["lastCachedInputTokens"] = n
	}
	if n, ok := number(last, "output_tokens"); ok {
		payload["outputTokens"] = n
		payload["lastOutputTokens"] = n
	}
	if n, ok := number(last, "reasoning_output_tokens"); ok {
		payload["reasoningOutputTokens"] = n
		payload["lastReasoningOutputTokens"] = n
	}
	if total, ok := info["total_token_usage"].(map[string]any); ok {
		if n, ok := number(total, "total_tokens"); ok && n > used {
			payload["totalProcessedTokens"] = n
		}
	}
	if n, ok := number(info, "model_context_window"); ok && n > 0 {
		payload["maxTokens"] = n
	}
	return &domain.CanonicalActivity{SourceID: id, Tone: domain.ToneInfo, Kind: "context-window.updated", Summary: "Context window updated", Payload: payload, Timestamp: timestamp}
}

func (a *Adapter) Load(ctx context.Context, s domain.SourceSummary, o domain.DiscoveryOptions) (domain.CanonicalConversation, error) {
	select {
	case <-ctx.Done():
		return domain.CanonicalConversation{}, ctx.Err()
	default:
	}
	rows, fp, mt, e := read(s.Path)
	if e != nil && strings.Contains(e.Error(), "SOURCE_CHANGED") {
		rows, fp, mt, e = read(s.Path)
	}
	if e != nil {
		return domain.CanonicalConversation{}, e
	}
	fallback := mt.UTC().Format(time.RFC3339Nano)
	turns := []*pending{}
	var active *pending
	session, ws, created, model, effort, branch := "", "", "", "default", "", ""
	idx := 0
	manualPrelude := false
	lastUsageSignature := ""
	ensure := func(ts, id string) *pending {
		if active == nil {
			if id == "" {
				id = fmt.Sprintf("turn-%d", idx)
			}
			active = &pending{id: id, started: ts, status: string(domain.TurnInProgress), calls: map[string]map[string]any{}}
		}
		return active
	}
	finish := func(t *pending) {
		turns = append(turns, t)
		if active == t {
			active = nil
		}
	}
	for _, r := range rows {
		idx++
		p := r.Payload
		ts := stamp(r.Timestamp, fallback)
		switch r.Type {
		case "session_meta":
			session = str(p["id"])
			if session == "" {
				session = str(p["session_id"])
			}
			ws = str(p["cwd"])
			created = stamp(p["timestamp"], ts)
			branch = str(p["git_branch"])
		case "turn_context":
			if str(p["model"]) != "" {
				model = str(p["model"])
			}
			effort = str(p["effort"])
			if str(p["cwd"]) != "" {
				ws = str(p["cwd"])
			}
		case "event_msg":
			et := str(p["type"])
			tid := str(p["turn_id"])
			find := func() *pending {
				if active != nil && (tid == "" || active.id == tid) {
					return active
				}
				for i := len(turns) - 1; i >= 0; i-- {
					if turns[i].id == tid {
						return turns[i]
					}
				}
				return nil
			}
			switch et {
			case "task_started":
				if active != nil && len(active.users) > 0 {
					finish(active)
				}
				manualPrelude = false
				active = ensure(stamp(p["started_at"], ts), tid)
			case "task_complete":
				if t := find(); t != nil {
					if msg := errorMessage(p["error"]); msg != "" {
						t.status = string(domain.TurnFailed)
						t.err = msg
					} else if t.status == string(domain.TurnInProgress) || t.status == string(domain.TurnCompleted) {
						t.status = string(domain.TurnCompleted)
					}
					t.completed = ts
					finish(t)
				}
			case "turn_aborted":
				if t := find(); t != nil {
					t.status = string(domain.TurnInterrupted)
					t.reason = str(p["reason"])
					t.completed = ts
					finish(t)
				}
			case "error":
				if t := find(); t != nil {
					detail := errorMessage(p)
					if detail == "" {
						detail = "Codex reported an error"
					}
					t.activities = append(t.activities, domain.CanonicalActivity{SourceID: fmt.Sprintf("error:%d", idx), Tone: domain.ToneError, Kind: "provider.error", Summary: "Provider error", Payload: map[string]any{"detail": detail, "historical": true}, Timestamp: ts})
					if statusAffectingError(p) {
						t.status = string(domain.TurnFailed)
						t.err = detail
						t.completed = ts
					}
				}
			}
			if et == "agent_reasoning" && active != nil {
				if detail := reasoningText(p); detail != "" {
					sourceID := fmt.Sprintf("event:%d", idx)
					active.activities = append(active.activities, domain.CanonicalActivity{SourceID: sourceID, Tone: domain.ToneInfo, Kind: "reasoning.summary", Summary: "Reasoning", Payload: map[string]any{"detail": detail}, Timestamp: ts})
				}
			}
			if (et == "context_compacted" || et == "context_compaction") && active != nil {
				active.activities = append(active.activities, domain.CanonicalActivity{SourceID: fmt.Sprintf("event:%d", idx), Tone: domain.ToneInfo, Kind: "context-compaction", Summary: "Context compacted", Payload: map[string]any{"state": "compacted"}, Timestamp: ts})
			}
			if et == "token_count" && active != nil {
				if info, ok := p["info"].(map[string]any); ok {
					if last, ok := info["last_token_usage"].(map[string]any); ok {
						signature, _ := json.Marshal(last)
						if string(signature) != lastUsageSignature {
							lastUsageSignature = string(signature)
							if activity := usageActivity(info, fmt.Sprintf("usage:%d", idx), ts); activity != nil {
								active.activities = append(active.activities, *activity)
							}
						}
					}
				}
			}
			if (strings.HasSuffix(et, "_end") || strings.HasSuffix(et, "_completed")) && active != nil && et != "agent_message" {
				itemType := ""
				switch {
				case strings.Contains(et, "patch"):
					itemType = "file_change"
				case strings.Contains(et, "web_search"):
					itemType = "web_search"
				case strings.Contains(et, "mcp"):
					itemType = "mcp_tool_call"
				}
				if itemType != "" {
					status := "completed"
					tone := domain.ToneTool
					if p["success"] == false {
						status = "failed"
						tone = domain.ToneError
					}
					active.activities = append(active.activities, domain.CanonicalActivity{SourceID: fmt.Sprintf("event:%d", idx), Tone: tone, Kind: "tool.completed", Summary: truncate(strings.ReplaceAll(et, "_", " "), 120), Payload: map[string]any{"itemType": itemType, "status": status, "data": map[string]any{"item": p}}, Timestamp: ts})
				}
			}
		case "response_item":
			typ := str(p["type"])
			if typ == "message" {
				role := str(p["role"])
				if role != "user" && role != "assistant" {
					continue
				}
				parts, _ := p["content"].([]any)
				var texts []string
				for _, part := range parts {
					if m, ok := part.(map[string]any); ok {
						v := str(m["text"])
						if v == "" {
							v = str(m["input_text"])
						}
						if v == "" {
							v = str(m["output_text"])
						}
						if v != "" {
							texts = append(texts, v)
						}
					}
				}
				txt := strings.TrimSpace(strings.Join(texts, "\n\n"))
				if role == "user" && active == nil && manualContextHandoff(txt) {
					manualPrelude = true
					continue
				}
				if manualPrelude {
					continue
				}
				attachments := parseImageAttachments(parts, role, idx)
				if txt == "" && len(attachments) == 0 {
					continue
				}
				if role == "user" && (strings.HasPrefix(txt, "<recommended_plugins>") || strings.HasPrefix(txt, "<environment_context>") || strings.HasPrefix(txt, "<app-context>") || strings.HasPrefix(txt, "<permissions instructions>")) {
					continue
				}
				t := ensure(ts, str(p["turn_id"]))
				if txt == "" {
					txt = "[Image attachment]"
				}
				m := domain.CanonicalMessage{SourceID: str(p["id"]), Role: role, Text: txt, Timestamp: ts, Attachments: attachments}
				if m.SourceID == "" {
					m.SourceID = fmt.Sprintf("message:%d", idx)
				}
				if role == "user" {
					t.users = append(t.users, m)
				} else {
					t.assistant = append(t.assistant, m)
				}
			} else if typ == "reasoning" {
				if active != nil {
					detail := reasoningText(p)
					if detail != "" {
						active.activities = append(active.activities, domain.CanonicalActivity{SourceID: str(p["id"]), Tone: domain.ToneInfo, Kind: "reasoning.summary", Summary: "Reasoning", Payload: map[string]any{"detail": detail}, Timestamp: ts})
					}
				}
			} else if typ == "custom_tool_call" || typ == "function_call" || typ == "local_shell_call" {
				t := ensure(ts, "")
				id := str(p["call_id"])
				if id == "" {
					id = str(p["id"])
				}
				name := str(p["name"])
				if name == "" && typ == "local_shell_call" {
					name = "Command"
				}
				if name == "" {
					name = "Tool"
				}
				input := p["input"]
				if input == nil {
					input = p["arguments"]
				}
				if input == nil {
					input = p["command"]
				}
				input = parseInput(input)
				t.calls[id] = map[string]any{"name": name, "input": input}
				if classifyTool(name) == "collab_agent_tool_call" && strings.Contains(strings.ToLower(name), "spawn") {
					record, _ := input.(map[string]any)
					title := str(record["task_name"])
					if title == "" {
						title = str(record["message"])
					}
					if title == "" {
						title = str(record["prompt"])
					}
					if title == "" {
						title = "Subagent task"
					}
					role := str(record["role"])
					if role == "" {
						role = "agent"
					}
					t.activities = append(t.activities, domain.CanonicalActivity{SourceID: id + ":task-started", Tone: domain.ToneInfo, Kind: "task.started", Summary: "Task started", Payload: map[string]any{"taskId": id, "title": truncate(title, 120), "detail": truncate(title, 180), "role": role, "agentKind": "agent", "toolUseId": id}, Timestamp: ts})
				}
				if name == "update_plan" {
					if inputMap, ok := input.(map[string]any); ok {
						if plan, ok := inputMap["plan"].([]any); ok {
							payload := map[string]any{"plan": plan}
							if exp, ok := inputMap["explanation"].(string); ok {
								payload["explanation"] = exp
							}
							t.activities = append(t.activities, domain.CanonicalActivity{SourceID: "plan-update:" + id, Tone: domain.ToneInfo, Kind: "turn.plan.updated", Summary: "Plan updated", Payload: payload, Timestamp: ts})
						}
					}
				}
			} else if typ == "custom_tool_call_output" || typ == "function_call_output" || typ == "local_shell_call_output" {
				t := ensure(ts, "")
				id := str(p["call_id"])
				call := t.calls[id]
				name := str(call["name"])
				if name == "" {
					name = "Tool"
				}
				output := p["output"]
				if output == nil {
					output = p["content"]
				}
				if output == nil {
					output = p
				}
				failed := false
				if om, ok := output.(map[string]any); ok {
					failed = om["is_error"] == true || om["success"] == false
				}
				status := "completed"
				tone := domain.ToneTool
				if failed {
					status = "failed"
					tone = domain.ToneError
				}
				itemType := classifyTool(name)
				summary := truncate(name, 120)
				payload := map[string]any{"itemType": itemType, "status": status, "title": name, "data": map[string]any{"toolCallId": id, "item": map[string]any{"name": name, "input": call["input"], "output": output}}}
				if detail := contentString(output); detail != "" {
					payload["detail"] = truncate(detail, 180)
				}
				if itemType == "collab_agent_tool_call" {
					payload["agentId"] = id
				}
				t.activities = append(t.activities, domain.CanonicalActivity{SourceID: id, Tone: tone, Kind: "tool.completed", Summary: summary, Payload: payload, Timestamp: ts})
				if classifyTool(name) == "collab_agent_tool_call" && strings.Contains(strings.ToLower(name), "spawn") {
					taskStatus := "completed"
					taskSummary := "Task completed"
					taskTone := domain.ToneInfo
					if failed {
						taskStatus = "failed"
						taskSummary = "Task failed"
						taskTone = domain.ToneError
					}
					t.activities = append(t.activities, domain.CanonicalActivity{SourceID: id + ":task-finished", Tone: taskTone, Kind: "task.updated", Summary: taskSummary, Payload: map[string]any{"taskId": id, "status": taskStatus, "agentKind": "agent", "toolUseId": id}, Timestamp: ts})
				}
			}
		}
	}
	appCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	appThread := readAppThread(appCtx, s.ID)
	cancel()
	if appThread != nil && len(appThread) > 0 {
		if ws == "" {
			ws = str(appThread["cwd"])
		}
		if n := str(appThread["name"]); strings.TrimSpace(n) != "" {
			s.Title = n
		} else if preview := str(appThread["preview"]); strings.TrimSpace(preview) != "" {
			s.Title = preview
		}
		if m := str(appThread["model"]); m != "" {
			model = m
		}
		if appTurns, ok := appThread["turns"].([]any); ok {
			for _, raw := range appTurns {
				am, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				id := str(am["id"])
				for _, t := range turns {
					if t.id != id {
						continue
					}
					if st := str(am["status"]); st == "completed" || st == "interrupted" || st == "failed" || st == "inProgress" {
						t.status = st
					}
					t.err = errorMessage(am["error"])
					t.reason = str(am["reason"])
					if t.completed == "" && t.status != "inProgress" {
						t.completed = stamp(am["completedAt"], fallback)
					}
				}
			}
		}
	}
	if active != nil && len(active.users) > 0 {
		turns = append(turns, active)
	}
	if session == "" || ws == "" {
		return domain.CanonicalConversation{}, fmt.Errorf("Codex rollout missing session id or workspace: %s", s.Path)
	}
	count := 0
	canonicalTurns := []domain.CanonicalTurn{}
	for _, t := range turns {
		if len(t.users) == 0 {
			continue
		}
		if t.status == string(domain.TurnInProgress) {
			count++
			if o.IncludeIncomplete == nil || !*o.IncludeIncomplete {
				continue
			}
		}
		user := t.users[0]
		if len(t.users) > 1 {
			var texts []string
			var at []domain.SourceAttachment
			for _, m := range t.users {
				texts = append(texts, m.Text)
				at = append(at, m.Attachments...)
			}
			user.Text = strings.Join(texts, "\n\n")
			if len(at) > 8 {
				at = at[:8]
			}
			user.Attachments = at
		}
		status := domain.TurnStatus(t.status)
		ct := domain.CanonicalTurn{ID: t.id, StartedAt: t.started, Status: status, User: user, Assistant: t.assistant, Activities: t.activities, Plans: t.plans}
		if t.completed != "" {
			ct.CompletedAt = &t.completed
		}
		if t.reason != "" {
			ct.TerminalReason = &t.reason
		}
		if t.err != "" {
			ct.TerminalError = &t.err
		}
		canonicalTurns = append(canonicalTurns, ct)
	}
	if len(canonicalTurns) == 0 {
		return domain.CanonicalConversation{}, fmt.Errorf("no importable Codex turns in %s", s.Path)
	}
	title := s.Title
	if title == "" {
		title = canonicalTurns[0].User.Text
		if len(title) > 80 {
			title = title[:80]
		}
	}
	updated := canonicalTurns[len(canonicalTurns)-1].User.Timestamp
	if x := canonicalTurns[len(canonicalTurns)-1].CompletedAt; x != nil {
		updated = *x
	}
	cthread := domain.CanonicalThread{Source: domain.SourceCodex, SourceSessionID: session, SourceKey: "codex:" + session, CurrentBranch: true, Title: title, Workspace: ws, Model: model, CreatedAt: created, UpdatedAt: updated, Turns: canonicalTurns, ResumeCursor: map[string]any{"threadId": session}, Warnings: []string{}}
	if branch != "" {
		cthread.GitBranch = &branch
	}
	if effort != "" {
		cthread.Effort = &effort
	}
	if count > 0 {
		cthread.IgnoredInProgressTurns = &count
	}
	summary := s
	summary.Title = title
	summary.Status = domain.SummaryComplete
	if count > 0 {
		summary.Status = domain.SummaryIncomplete
	}
	return domain.CanonicalConversation{Summary: summary, Threads: []domain.CanonicalThread{cthread}, Fingerprint: fp}, nil
}
