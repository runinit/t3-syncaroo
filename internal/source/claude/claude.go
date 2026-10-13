package claude

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/runinit/t3-syncaroo/internal/domain"
)

var errChangedDuringRead = errors.New("SOURCE_CHANGED_DURING_READ")

type Adapter struct{ root string }

func New(root string) *Adapter {
	if strings.TrimSpace(root) == "" {
		root = os.Getenv("CLAUDE_CONFIG_DIR")
		if root == "" {
			h, _ := os.UserHomeDir()
			root = filepath.Join(h, ".claude")
		}
	}
	return &Adapter{root: root}
}
func (a *Adapter) Name() domain.SourceName { return domain.SourceClaude }
func (a *Adapter) Discover(ctx context.Context, o domain.DiscoveryOptions) ([]domain.SourceSummary, error) {
	r, e := a.DiscoverWithOutcomes(ctx, o)
	return r.Summaries, e
}

type node struct {
	id, parent, typ, ts string
	row                 map[string]any
	side                bool
}
type metadata struct {
	id, workspace, title, created, updated, model, effort, branch string
	nodes                                                         map[string]*node
	leaves                                                        []*node
	current                                                       *node
	trusted                                                       bool
}

func obj(v any) map[string]any { m, _ := v.(map[string]any); return m }
func str(v any) string         { s, _ := v.(string); return strings.TrimSpace(s) }
func stamp(v any, fallback string) string {
	var t time.Time
	switch x := v.(type) {
	case string:
		t, _ = time.Parse(time.RFC3339Nano, x)
	case float64:
		if x < 1e10 {
			x *= 1000
		}
		t = time.UnixMilli(int64(x)).UTC()
	}
	if t.IsZero() {
		return fallback
	}
	return t.UTC().Format(time.RFC3339Nano)
}
func content(row map[string]any) any { return obj(row["message"])["content"] }
func blocks(v any) []map[string]any {
	a, _ := v.([]any)
	out := []map[string]any{}
	for _, x := range a {
		if m := obj(x); m != nil {
			out = append(out, m)
		}
	}
	return out
}
func text(v any) string {
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s)
	}
	var b []string
	for _, x := range blocks(v) {
		if x["type"] == "text" {
			if s := str(x["text"]); s != "" {
				b = append(b, s)
			}
		}
	}
	return strings.TrimSpace(strings.Join(b, "\n\n"))
}
func attachment(v any, id string) []domain.SourceAttachment {
	var out []domain.SourceAttachment
	for i, b := range blocks(v) {
		if b["type"] != "image" {
			continue
		}
		src := obj(b["source"])
		mime := str(src["media_type"])
		if mime == "" {
			mime = "image/unknown"
		}
		key := fmt.Sprintf("%s:image:%d", id, i)
		if src["type"] == "base64" && str(src["data"]) != "" {
			d, _ := base64.StdEncoding.DecodeString(str(src["data"]))
			out = append(out, domain.SourceAttachment{SourceID: key, Name: fmt.Sprintf("image-%d", i+1), MIMEType: mime, SizeBytes: int64(len(d)), Data: &domain.Buffer{Data: d}})
		} else if u := str(src["url"]); u != "" {
			out = append(out, domain.SourceAttachment{SourceID: key, Name: fmt.Sprintf("image-%d", i+1), MIMEType: mime, RemoteURL: &u})
		}
	}
	return out
}
func endpoint(n *node) bool {
	if n.side || (n.typ != "user" && n.typ != "assistant") || n.row["isCompactSummary"] == true {
		return false
	}
	return text(content(n.row)) != "" || n.typ == "user" && len(attachment(content(n.row), n.id)) > 0
}
func analyze(rows []map[string]any, fallback string) (*metadata, error) {
	m := &metadata{nodes: map[string]*node{}, created: fallback, updated: fallback, model: "default"}
	var current string
	for _, r := range rows {
		if id := str(r["sessionId"]); id != "" {
			m.id = id
		}
		if m.workspace == "" {
			m.workspace = str(r["cwd"])
		}
		if s := str(r["effort"]); s != "" {
			m.effort = s
		}
		if s := str(r["gitBranch"]); s != "" {
			m.branch = s
		}
		if r["type"] == "custom-title" {
			m.title = str(r["customTitle"])
		}
		if r["type"] == "ai-title" && m.title == "" {
			m.title = str(r["aiTitle"])
		}
		if r["type"] == "last-prompt" {
			current = str(r["leafUuid"])
		}
		id, typ := str(r["uuid"]), str(r["type"])
		if id == "" || typ == "" {
			continue
		}
		ts := stamp(r["timestamp"], fallback)
		if ts < m.created {
			m.created = ts
		}
		if ts > m.updated {
			m.updated = ts
		}
		if typ == "assistant" {
			if x := str(obj(r["message"])["model"]); x != "" {
				m.model = x
			}
		}
		m.nodes[id] = &node{id: id, parent: str(r["parentUuid"]), typ: typ, ts: ts, row: r, side: r["isSidechain"] == true}
	}
	if m.id == "" || m.workspace == "" {
		return nil, errors.New("Claude transcript has no sessionId or cwd")
	}
	main := []*node{}
	for _, n := range m.nodes {
		if !n.side {
			main = append(main, n)
		}
	}
	if len(main) == 0 {
		return nil, errors.New("Claude transcript contains only sidechain history")
	}
	// Reconnect compact boundaries when target is local and older.
	for _, n := range main {
		if n.typ == "system" && n.row["subtype"] == "compact_boundary" && n.parent == "" {
			p := str(n.row["logicalParentUuid"])
			if q := m.nodes[p]; q != nil && !q.side && q.ts <= n.ts && !isAncestor(m.nodes, n.id, q) {
				n.parent = p
			}
		}
	}
	reconnectRetries(m.nodes)
	// Endpoints are terminal conversational nodes on parent graph.
	parents := map[string]bool{}
	for _, n := range main {
		if n.parent != "" {
			parents[n.parent] = true
		}
	}
	cand := []*node{}
	for _, n := range main {
		if !parents[n.id] {
			x := n
			seen := map[string]bool{}
			for x != nil && !seen[x.id] {
				seen[x.id] = true
				if endpoint(x) {
					cand = append(cand, x)
					break
				}
				x = m.nodes[x.parent]
			}
		}
	}
	uniq := map[string]*node{}
	for _, n := range cand {
		uniq[n.id] = n
	}
	for _, n := range uniq {
		desc := false
		for _, q := range uniq {
			if n == q {
				continue
			}
			for x := q; x != nil; x = m.nodes[x.parent] {
				if x.id == n.id {
					desc = true
					break
				}
			}
			if desc {
				break
			}
		}
		if !desc {
			m.leaves = append(m.leaves, n)
		}
	}
	if len(m.leaves) == 0 {
		return nil, errors.New("Claude transcript has no conversation leaf")
	}
	sort.Slice(m.leaves, func(i, j int) bool { return m.leaves[i].ts < m.leaves[j].ts })
	for _, l := range m.leaves {
		if l.id == current {
			m.current = l
			m.trusted = true
		}
	}
	if m.current == nil {
		m.current = m.leaves[len(m.leaves)-1]
	}
	m.trusted = m.trusted || len(m.leaves) == 1
	if m.title == "" {
		for _, n := range main {
			if n.typ == "user" && endpoint(n) {
				m.title = text(content(n.row))
				break
			}
		}
	}
	if m.title == "" {
		m.title = "Claude conversation"
	}
	if len(m.title) > 72 {
		m.title = m.title[:71] + "…"
	}
	return m, nil
}
func read(path string) ([]map[string]any, string, error) {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		rows, fingerprint, err := readOnce(path)
		if !errors.Is(err, errChangedDuringRead) {
			return rows, fingerprint, err
		}
		lastErr = err
	}
	return nil, "", lastErr
}

func readOnce(path string) ([]map[string]any, string, error) {
	f, e := os.Open(path)
	if e != nil {
		return nil, "", e
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		return nil, "", e
	}
	data, e := io.ReadAll(f)
	if e != nil {
		return nil, "", e
	}
	h := sha256.Sum256(data)
	rows := []map[string]any{}
	sc := bufio.NewScanner(strings.NewReader(string(data)))
	sc.Buffer(make([]byte, 4096), 16<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if len(bytesTrim(line)) == 0 {
			continue
		}
		var v map[string]any
		if err := json.Unmarshal(line, &v); err != nil {
			return nil, "", fmt.Errorf("malformed Claude JSONL near record %d: %w", len(rows)+1, err)
		} else if v == nil {
			return nil, "", fmt.Errorf("malformed Claude JSONL near record %d: expected object", len(rows)+1)
		}
		rows = append(rows, v)
	}
	if e = sc.Err(); e != nil {
		return nil, "", e
	}
	after, e := f.Stat()
	if e != nil {
		return nil, "", e
	}
	pathStat, e := os.Stat(path)
	if e != nil {
		return nil, "", errChangedDuringRead
	}
	if !os.SameFile(st, after) || !os.SameFile(st, pathStat) || st.Size() != after.Size() || st.ModTime() != after.ModTime() || st.Size() != pathStat.Size() || st.ModTime() != pathStat.ModTime() {
		return nil, "", errChangedDuringRead
	}
	return rows, hex.EncodeToString(h[:]), nil
}
func bytesTrim(b []byte) []byte { return []byte(strings.TrimSpace(string(b))) }

func isAncestor(nodes map[string]*node, ancestorID string, n *node) bool {
	seen := map[string]bool{}
	for n != nil && !seen[n.id] {
		if n.id == ancestorID {
			return true
		}
		seen[n.id] = true
		n = nodes[n.parent]
	}
	return false
}

func children(nodes map[string]*node) map[string][]*node {
	out := map[string][]*node{}
	for _, n := range nodes {
		if n.parent != "" && !n.side {
			out[n.parent] = append(out[n.parent], n)
		}
	}
	return out
}

func descendants(root *node, childMap map[string][]*node) []*node {
	var out []*node
	pending := []*node{root}
	seen := map[string]bool{}
	for len(pending) > 0 {
		n := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if seen[n.id] {
			continue
		}
		seen[n.id] = true
		out = append(out, n)
		pending = append(pending, childMap[n.id]...)
	}
	return out
}

func completedRetryEndpoint(nodes map[string]*node, root *node, childMap map[string][]*node) *node {
	branch := descendants(root, childMap)
	inside := map[string]bool{}
	for _, n := range branch {
		inside[n.id] = true
		if n.typ == "user" && endpoint(n) {
			return nil
		}
	}
	var endpoints map[string]*node = map[string]*node{}
	for _, n := range branch {
		leaf := true
		for _, child := range childMap[n.id] {
			if inside[child.id] {
				leaf = false
				break
			}
		}
		if !leaf {
			continue
		}
		for x, seen := n, map[string]bool{}; x != nil && !seen[x.id]; x = nodes[x.parent] {
			seen[x.id] = true
			if endpoint(x) {
				if inside[x.id] {
					endpoints[x.id] = x
				}
				break
			}
		}
	}
	if len(endpoints) != 1 {
		return nil
	}
	for _, n := range endpoints {
		if n.typ != "assistant" {
			return nil
		}
		switch str(obj(n.row["message"])["stop_reason"]) {
		case "end_turn", "stop_sequence", "refusal", "max_tokens":
			return n
		}
	}
	return nil
}

func reconnectRetries(nodes map[string]*node) {
	for _, retry := range nodes {
		if retry.side || retry.typ != "system" || retry.row["subtype"] != "api_error" || retry.parent == "" {
			continue
		}
		attempt, ok1 := retry.row["retryAttempt"].(float64)
		maximum, ok2 := retry.row["maxRetries"].(float64)
		if !ok1 || !ok2 || attempt < 0 || maximum < 0 || attempt >= maximum {
			continue
		}
		childMap := children(nodes)
		var candidates []*node
		for _, root := range childMap[retry.parent] {
			if root.id == retry.id || root.typ != "assistant" || root.ts < retry.ts {
				continue
			}
			if endpoint := completedRetryEndpoint(nodes, root, childMap); endpoint != nil {
				candidates = append(candidates, root)
			}
		}
		if len(candidates) != 1 {
			continue
		}
		continuation := childMap[retry.id]
		if len(continuation) > 1 {
			continue
		}
		root := candidates[0]
		endpoint := completedRetryEndpoint(nodes, root, childMap)
		if endpoint == nil || isAncestor(nodes, root.id, retry) {
			continue
		}
		if len(continuation) == 1 && continuation[0].ts < endpoint.ts {
			continue
		}
		root.parent = retry.id
		if len(continuation) == 1 {
			continuation[0].parent = endpoint.id
		}
	}
}

func (a *Adapter) DiscoverWithOutcomes(ctx context.Context, o domain.DiscoveryOptions) (domain.SourceDiscoveryResult, error) {
	root := filepath.Join(a.root, "projects")
	res := domain.SourceDiscoveryResult{Summaries: []domain.SourceSummary{}, Outcomes: []domain.SessionOutcomeRecord{}}
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, e error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if e != nil {
			if errors.Is(e, os.ErrNotExist) && path == root {
				return nil
			}
			res.Outcomes = append(res.Outcomes, outcome(path, "source-scan-failed", "failed"))
			return nil
		}
		if d.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}
		rows, _, e := read(path)
		if e != nil {
			res.Outcomes = append(res.Outcomes, outcome(path, errorCode(e), "failed"))
			return nil
		}
		st, _ := os.Stat(path)
		fb := time.Now().UTC().Format(time.RFC3339Nano)
		if st != nil {
			fb = st.ModTime().UTC().Format(time.RFC3339Nano)
		}
		m, e := analyze(rows, fb)
		if e != nil {
			code := "source-unreadable"
			kind := "failed"
			if strings.Contains(e.Error(), "only sidechain") {
				code = "claude-sidechain-session"
				kind = "unsupported"
			}
			rec := outcome(path, code, kind)
			res.Outcomes = append(res.Outcomes, rec)
			return nil
		}
		if o.Workspace != nil && !samePath(m.workspace, *o.Workspace) {
			return nil
		}
		if o.Since != nil {
			u, _ := time.Parse(time.RFC3339Nano, m.updated)
			if u.Before(*o.Since) {
				return nil
			}
		}
		status := domain.SummaryComplete
		if m.current.typ != "assistant" {
			status = domain.SummaryIncomplete
		}
		res.Summaries = append(res.Summaries, domain.SourceSummary{Source: domain.SourceClaude, ID: m.id, Title: m.title, Workspace: m.workspace, Path: path, CreatedAt: m.created, UpdatedAt: m.updated, Status: status, Branches: len(m.leaves)})
		return nil
	})
	if err != nil {
		return res, err
	}
	sort.Slice(res.Summaries, func(i, j int) bool { return res.Summaries[i].UpdatedAt > res.Summaries[j].UpdatedAt })
	return res, nil
}
func outcome(path, code, kind string) domain.SessionOutcomeRecord {
	return domain.SessionOutcomeRecord{Source: domain.SourceClaude, SourcePath: ptr(path), DisplayName: filepath.Base(path), Outcome: domain.SessionOutcome{Kind: domain.OutcomeKind(kind), Phase: domain.PhaseDiscovery, Code: code, Message: "The Claude transcript could not be read or parsed.", NextAction: "Check that the transcript is readable JSONL and unchanged, then rediscover."}}
}
func errorCode(e error) string {
	if errors.Is(e, errChangedDuringRead) {
		return "source-changed-during-read"
	}
	if errors.Is(e, os.ErrNotExist) {
		return "source-path-changed"
	}
	if errors.Is(e, os.ErrPermission) {
		return "source-permission-denied"
	}
	return "source-unreadable"
}
func samePath(a, b string) bool {
	x, _ := filepath.Abs(a)
	y, _ := filepath.Abs(b)
	return filepath.Clean(x) == filepath.Clean(y)
}
func lineage(m *metadata, l *node) []*node {
	out := []*node{}
	seen := map[string]bool{}
	for n := l; n != nil && !seen[n.id]; n = m.nodes[n.parent] {
		seen[n.id] = true
		if !n.side {
			out = append(out, n)
		}
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}
func (a *Adapter) Load(ctx context.Context, s domain.SourceSummary, o domain.DiscoveryOptions) (domain.CanonicalConversation, error) {
	rows, fp, e := read(s.Path)
	if e != nil {
		return domain.CanonicalConversation{}, e
	}
	fb := time.Now().UTC().Format(time.RFC3339Nano)
	if st, x := os.Stat(s.Path); x == nil {
		fb = st.ModTime().UTC().Format(time.RFC3339Nano)
	}
	m, e := analyze(rows, fb)
	if e != nil {
		return domain.CanonicalConversation{}, e
	}
	threads := []domain.CanonicalThread{}
	for i, l := range m.leaves {
		if ctx.Err() != nil {
			return domain.CanonicalConversation{}, ctx.Err()
		}
		threads = append(threads, build(m, l, i))
	}
	for i := range threads {
		if o.IncludeIncomplete == nil || !*o.IncludeIncomplete {
			n := 0
			turns := threads[i].Turns[:0]
			for _, t := range threads[i].Turns {
				if t.Status.Terminal() {
					turns = append(turns, t)
				} else {
					n++
				}
			}
			threads[i].Turns = turns
			if n > 0 {
				threads[i].IgnoredInProgressTurns = &n
			}
		}
	}
	status := domain.SummaryComplete
	for _, t := range threads {
		if t.IgnoredInProgressTurns != nil {
			status = domain.SummaryIncomplete
		}
	}
	s.Branches = len(m.leaves)
	s.Status = status
	return domain.CanonicalConversation{Summary: s, Threads: threads, Fingerprint: fp}, nil
}
func build(m *metadata, leaf *node, index int) domain.CanonicalThread {
	chain := lineage(m, leaf)
	t := domain.CanonicalThread{Source: domain.SourceClaude, SourceSessionID: m.id, SourceKey: "claude:" + m.id + ":" + leaf.id, LeafID: &leaf.id, CurrentBranch: m.trusted && leaf == m.current, Title: m.title, Workspace: m.workspace, Model: m.model, CreatedAt: m.created, UpdatedAt: m.updated, Turns: []domain.CanonicalTurn{}, Warnings: []string{}}
	if m.branch != "" {
		t.GitBranch = &m.branch
	}
	if m.effort != "" {
		t.Effort = &m.effort
	}
	if !t.CurrentBranch && len(m.leaves) > 1 {
		t.Title += fmt.Sprintf(" · historical %d", index+1)
		t.Warnings = append(t.Warnings, "Alternate Claude branch selected; continuation uses this branch's saved assistant head.")
	}
	if !m.trusted && len(m.leaves) > 1 {
		t.Warnings = []string{"Claude's active branch is ambiguous because the saved last-prompt marker does not identify one branch."}
	}
	var active *domain.CanonicalTurn
	toolResults := map[string]map[string]any{}
	for _, n := range m.nodes {
		if n.typ == "user" {
			for _, b := range blocks(content(n.row)) {
				if b["type"] == "tool_result" {
					if id := str(b["tool_use_id"]); id != "" {
						toolResults[id] = b
					}
				}
			}
		}
	}
	lastAssistantID := ""
	lastUsageSignature := ""
	for _, n := range chain {
		bs := blocks(content(n.row))
		if n.typ == "user" {
			if n.row["isCompactSummary"] == true {
				continue
			}
			txt := text(content(n.row))
			att := attachment(content(n.row), n.id)
			if txt == "" && len(att) == 0 {
				continue
			}
			if active != nil {
				if active.Status == domain.TurnInProgress {
					active.Status = domain.TurnInterrupted
					active.TerminalReason = ptr("next_user_message")
					active.CompletedAt = ptr(n.ts)
				}
				t.Turns = append(t.Turns, *active)
			}
			display := txt
			if display == "" {
				display = "[Image attachment]"
			}
			active = &domain.CanonicalTurn{ID: n.id, StartedAt: n.ts, Status: domain.TurnInProgress, User: domain.CanonicalMessage{SourceID: n.id, Role: "user", Text: display, Timestamp: n.ts, Attachments: att}, Assistant: []domain.CanonicalMessage{}, Activities: []domain.CanonicalActivity{}, Plans: []domain.CanonicalPlan{}}
		} else if n.typ == "assistant" && active != nil {
			lastAssistantID = n.id
			if usage := usageActivity(n); usage != nil {
				encoded, _ := json.Marshal(usage.Payload)
				if string(encoded) != lastUsageSignature {
					lastUsageSignature = string(encoded)
					active.Activities = append(active.Activities, *usage)
				}
			}
			for i, b := range bs {
				typ := str(b["type"])
				switch typ {
				case "text":
					if x := str(b["text"]); x != "" {
						active.Assistant = append(active.Assistant, domain.CanonicalMessage{SourceID: fmt.Sprintf("%s:text:%d", n.id, i), Role: "assistant", Text: x, Timestamp: n.ts, Attachments: []domain.SourceAttachment{}})
					}
				case "thinking":
					if x := str(b["thinking"]); x != "" {
						active.Activities = append(active.Activities, activity(n.id+fmt.Sprintf(":thinking:%d", i), "info", "reasoning.summary", "Reasoning", map[string]any{"detail": x}, n.ts))
					}
				case "tool_use":
					id := str(b["id"])
					if id == "" {
						id = fmt.Sprintf("%s:tool:%d", n.id, i)
					}
					name := str(b["name"])
					input := obj(b["input"])
					isAgent := toolType(name) == "collab_agent_tool_call"
					if isAgent {
						description := str(input["description"])
						if description == "" {
							description = str(input["prompt"])
						}
						if description == "" {
							description = "Subagent task"
						}
						role := str(input["subagent_type"])
						if role == "" {
							role = "general-purpose"
						}
						active.Activities = append(active.Activities, activity(id+":started", domain.ToneInfo, "task.started", "Task started", map[string]any{"taskId": id, "title": truncate(description, 120), "detail": truncate(description, 180), "role": role, "agentKind": "agent", "toolUseId": id}, n.ts))
					}
					if name == "TodoWrite" {
						if plan := normalizePlan(input); len(plan) > 0 {
							active.Activities = append(active.Activities, activity(id+":plan", domain.ToneInfo, "turn.plan.updated", "Plan updated", map[string]any{"explanation": "Claude Tasks", "plan": plan}, n.ts))
						}
					}
					if name == "ExitPlanMode" {
						if markdown := str(input["plan"]); markdown != "" {
							active.Plans = append(active.Plans, domain.CanonicalPlan{SourceID: id, Markdown: markdown, Timestamp: n.ts})
						}
					}
					res := toolResults[id]
					out := res["content"]
					detail := text(out)
					failed := res["is_error"] == true
					status := "completed"
					tone := domain.ToneTool
					if failed {
						status, tone = "failed", domain.ToneError
					}
					payload := map[string]any{"itemType": toolType(name), "status": status, "title": name, "data": map[string]any{"toolCallId": id, "item": map[string]any{"name": name, "input": b["input"], "output": out}}}
					if isAgent {
						payload["agentId"] = id
					}
					if detail != "" {
						payload["detail"] = detail
					} else if res == nil {
						payload["detail"] = "Historical tool call has no recorded result."
					}
					active.Activities = append(active.Activities, activity(id, tone, "tool.completed", name, payload, n.ts))
					if isAgent {
						taskStatus, taskSummary, taskTone := "completed", "Task completed", domain.ToneInfo
						if failed {
							taskStatus, taskSummary, taskTone = "failed", "Task failed", domain.ToneError
						} else if res == nil {
							taskStatus, taskSummary = "interrupted", "Task interrupted"
						}
						active.Activities = append(active.Activities, activity(id+":finished", taskTone, "task.updated", taskSummary, map[string]any{"taskId": id, "status": taskStatus, "agentKind": "agent", "toolUseId": id}, n.ts))
					}
				}
			}
			stop := str(obj(n.row["message"])["stop_reason"])
			switch stop {
			case "end_turn", "stop_sequence", "refusal":
				active.Status = domain.TurnCompleted
				active.CompletedAt = ptr(n.ts)
				if stop == "refusal" {
					active.TerminalReason = ptr(stop)
					active.Activities = append(active.Activities, activity(n.id+":refusal", domain.ToneInfo, "provider.refusal", "Claude refused the request", map[string]any{"historical": true}, n.ts))
				}
			case "max_tokens":
				active.Status = domain.TurnInterrupted
				active.TerminalReason = ptr(stop)
				active.CompletedAt = ptr(n.ts)
				active.Activities = append(active.Activities, activity(n.id+":max-tokens", domain.ToneInfo, "turn.interrupted", "Turn truncated", map[string]any{"status": "interrupted", "detail": "Claude stopped after reaching the maximum token limit."}, n.ts))
			case "model_context_window_exceeded", "context_window_exceeded":
				active.Status = domain.TurnFailed
				active.TerminalReason = ptr(stop)
				msg := "Claude exceeded the model context window."
				active.TerminalError = &msg
				active.CompletedAt = ptr(n.ts)
				active.Activities = append(active.Activities, activity(n.id+":context-window-error", domain.ToneError, "turn.failed", "Turn failed", map[string]any{"status": "failed", "detail": msg}, n.ts))
			}
		} else if (n.typ == "system" || n.typ == "result") && active != nil {
			st := str(n.row["subtype"])
			if st == "api_error" {
				detail := str(n.row["error"])
				if detail == "" {
					detail = str(n.row["message"])
					if detail == "" {
						detail = "Claude API request failed and was retried."
					}
				}
				active.Activities = append(active.Activities, activity(n.id, "error", "provider.error", "Claude API retry", map[string]any{"detail": detail, "historical": true, "retrying": true}, n.ts))
			}
			if st == "compact_boundary" {
				active.Activities = append(active.Activities, activity(n.id, "info", "context-compaction", "Context compacted", map[string]any{"state": "compacted"}, n.ts))
			}
			executionResult := n.typ == "result" || st == "execution_result" || st == "result" || st == "local_command"
			if executionResult && (n.row["is_error"] == true || strings.HasPrefix(st, "error_") || st == "error" || str(n.row["status"]) == "error" || str(n.row["status"]) == "failed" || str(n.row["status"]) == "failure") {
				detail := str(n.row["error"])
				if detail == "" {
					detail = str(n.row["message"])
					if detail == "" {
						detail = text(n.row["message"])
					}
				}
				if detail == "" {
					detail = str(n.row["result"])
				}
				if detail == "" {
					detail = "Claude execution failed."
				}
				active.Status = domain.TurnFailed
				active.TerminalReason = ptr(st)
				active.TerminalError = &detail
				active.CompletedAt = ptr(n.ts)
				active.Activities = append(active.Activities, activity(n.id+":failed", "error", "turn.failed", "Turn failed", map[string]any{"status": "failed", "detail": detail}, n.ts))
			} else if executionResult && (st == "success" || str(n.row["status"]) == "success" || str(n.row["status"]) == "completed") {
				active.Status = domain.TurnCompleted
				active.CompletedAt = ptr(n.ts)
			}
		}
	}
	if active != nil {
		t.Turns = append(t.Turns, *active)
	}
	if len(t.Turns) > 0 {
		last := t.Turns[len(t.Turns)-1]
		t.UpdatedAt = last.User.Timestamp
		if last.CompletedAt != nil {
			t.UpdatedAt = *last.CompletedAt
		} else if len(last.Assistant) > 0 {
			t.UpdatedAt = last.Assistant[len(last.Assistant)-1].Timestamp
		}
	}
	if lastAssistantID != "" {
		t.ResumeCursor = map[string]any{"resume": m.id, "resumeSessionAt": lastAssistantID, "turnCount": len(t.Turns)}
	}
	return t
}

func usageActivity(n *node) *domain.CanonicalActivity {
	usage := obj(obj(n.row["message"])["usage"])
	if usage == nil {
		return nil
	}
	if its, ok := usage["iterations"].([]any); ok && len(its) > 0 {
		if last := obj(its[len(its)-1]); last != nil {
			usage = last
		}
	}
	get := func(k string) int64 {
		v, ok := usage[k].(float64)
		if !ok || v < 0 {
			return 0
		}
		return int64(v)
	}
	input := get("input_tokens") + get("cache_creation_input_tokens") + get("cache_read_input_tokens")
	output := get("output_tokens")
	used := get("total_tokens")
	if used == 0 {
		used = input + output
	}
	if used <= 0 {
		return nil
	}
	p := map[string]any{"usedTokens": used, "lastUsedTokens": used}
	if input > 0 {
		p["inputTokens"] = input
		p["lastInputTokens"] = input
	}
	if c := get("cache_read_input_tokens"); c > 0 {
		p["cachedInputTokens"] = c
		p["lastCachedInputTokens"] = c
	}
	if output > 0 {
		p["outputTokens"] = output
		p["lastOutputTokens"] = output
	}
	a := activity(n.id+":usage", domain.ToneInfo, "context-window.updated", "Context window updated", p, n.ts)
	return &a
}
func ptr(s string) *string { return &s }
func truncate(s string, limit int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= limit {
		return s
	}
	if limit < 1 {
		return ""
	}
	return string(r[:limit-1]) + "…"
}
func normalizePlan(input map[string]any) []map[string]string {
	items, ok := input["todos"].([]any)
	if !ok {
		items, _ = input["plan"].([]any)
	}
	out := []map[string]string{}
	for _, raw := range items {
		v := obj(raw)
		step := str(v["content"])
		if step == "" {
			step = str(v["step"])
		}
		if step == "" {
			step = str(v["subject"])
		}
		if step == "" {
			continue
		}
		state := str(v["status"])
		switch state {
		case "completed":
		case "in_progress", "inProgress":
			state = "inProgress"
		default:
			state = "pending"
		}
		out = append(out, map[string]string{"step": step, "status": state})
	}
	return out
}
func activity(id string, tone domain.ActivityTone, kind, summary string, payload map[string]any, ts string) domain.CanonicalActivity {
	return domain.CanonicalActivity{SourceID: id, Tone: tone, Kind: kind, Summary: summary, Payload: payload, Timestamp: ts}
}
func toolType(s string) string {
	x := strings.ToLower(s)
	switch {
	case x == "bash" || strings.Contains(x, "shell") || strings.Contains(x, "command"):
		return "command_execution"
	case strings.Contains(x, "edit") || strings.Contains(x, "write"):
		return "file_change"
	case strings.Contains(x, "web") || strings.Contains(x, "search"):
		return "web_search"
	case strings.Contains(x, "mcp"):
		return "mcp_tool_call"
	case x == "task" || strings.Contains(x, "agent"):
		return "collab_agent_tool_call"
	case x == "read" || strings.Contains(x, "image"):
		return "image_view"
	default:
		return "dynamic_tool_call"
	}
}
