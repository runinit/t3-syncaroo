// Package v2 writes the narrow, importer-owned subset of T3's pinned v2 event
// stream. It intentionally does not own backup, assets, or import ledgers.
package v2

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/runinit/t3-syncaroo/internal/domain"
	"github.com/runinit/t3-syncaroo/internal/target/assets"
	targetschema "github.com/runinit/t3-syncaroo/internal/target/schema"
)

type Event struct {
	ID                 string          `json:"id"`
	Type               string          `json:"type"`
	ThreadID           string          `json:"threadId"`
	ProviderInstanceID string          `json:"providerInstanceId,omitempty"`
	Driver             string          `json:"driver,omitempty"`
	OccurredAt         string          `json:"occurredAt"`
	Payload            json.RawMessage `json:"payload"`
	Metadata           json.RawMessage `json:"metadata,omitempty"`
}

type ProjectEvent struct {
	CommandID  string
	AcceptedAt string
	EventID    string
	ProjectID  string
	OccurredAt string
	Payload    json.RawMessage
}

type Plan struct {
	ThreadID, ProjectID, ProviderInstanceID string
	Project                                 *ProjectEvent
	Runtime                                 *RuntimeBinding
	Events                                  []Event
	Assets                                  []assets.Asset
	Warnings                                []string
}

// RuntimeBinding is the stopped provider runtime record that allows T3 to
// continue a trusted native source session after importing its history.
type RuntimeBinding struct {
	ThreadID, ProviderName, ProviderInstanceID, AdapterKey string
	LastSeenAt, ResumeCursorJSON, RuntimePayloadJSON       string
}

// BuildPlan encodes the deterministic, database-visible part of a pinned T3 v2
// import plan. Asset bytes are deliberately left to the caller.
func BuildPlan(thread domain.CanonicalThread, threadID, projectID, providerInstanceID string, modelOptions map[string]any, createProject bool) (Plan, error) {
	return BuildPlanWithOptions(thread, threadID, projectID, providerInstanceID, modelOptions, createProject, "")
}

func BuildPlanWithOptions(thread domain.CanonicalThread, threadID, projectID, providerInstanceID string, modelOptions map[string]any, createProject bool, attachmentsDir string) (Plan, error) {
	return BuildPlanWithRuntimeOptions(thread, threadID, projectID, providerInstanceID, thread.Model, modelOptions, createProject, attachmentsDir, false)
}

// BuildPlanWithRuntimeOptions additionally records the resolved provider model
// and, when allowed, a stopped runtime binding for a trusted source cursor.
func BuildPlanWithRuntimeOptions(thread domain.CanonicalThread, threadID, projectID, providerInstanceID, providerModel string, modelOptions map[string]any, createProject bool, attachmentsDir string, resumable bool) (Plan, error) {
	if !thread.Source.Valid() || threadID == "" || projectID == "" || providerInstanceID == "" || len(thread.Turns) == 0 {
		return Plan{}, errors.New("v2: canonical thread and explicit target identities are required")
	}
	for _, turn := range thread.Turns {
		if !turn.Status.Terminal() {
			return Plan{}, fmt.Errorf("v2: thread %s contains unsettled turn", thread.SourceSessionID)
		}
	}
	seed := thread.SourceKey
	providerThreadID := uuid("t3-import:v2:provider-thread:" + seed)
	driver := "codex"
	if thread.Source == domain.SourceClaude {
		driver = "claudeAgent"
	}
	if providerModel == "" {
		providerModel = thread.Model
	}
	model := map[string]any{"instanceId": providerInstanceID, "model": providerModel, "options": modelOptions}
	if modelOptions == nil {
		model["options"] = map[string]any{}
	}
	threadPayload := map[string]any{"createdBy": "system", "creationSource": "server", "id": threadID, "projectId": projectID, "title": stringsTrim(thread.Title), "providerInstanceId": providerInstanceID, "modelSelection": model, "runtimeMode": "full-access", "interactionMode": "default", "branch": thread.GitBranch, "worktreePath": nil, "linkedPullRequest": nil, "branchPullRequest": nil, "activeProviderThreadId": providerThreadID, "historyOrigin": "v1_import", "lineage": map[string]any{"parentThreadId": nil, "relationshipToParent": nil, "rootThreadId": threadID}, "forkedFrom": nil, "createdAt": thread.CreatedAt, "updatedAt": thread.UpdatedAt, "archivedAt": nil, "settledOverride": "settled", "settledAt": thread.UpdatedAt, "unsettledAt": nil, "snoozedUntil": nil, "snoozedAt": nil, "pinnedAt": nil, "pinOrderKey": nil, "activeOrderKey": nil, "lastVisitedAt": nil, "deletedAt": nil}
	threadPayload["branch"] = nil
	if thread.GitBranch != nil {
		threadPayload["branch"] = *thread.GitBranch
	}
	events := []Event{makeEvent(thread, threadID, "thread-created", "thread.created", thread.CreatedAt, threadPayload, driver)}
	history, err := encodeHistory(thread, threadID, attachmentsDir)
	if err != nil {
		return Plan{}, err
	}
	events = append(events, history.Events...)
	var nativeThreadRef any
	if resumable && len(thread.ResumeCursor) > 0 {
		if nativeID := nativeSessionID(thread); nativeID != "" {
			nativeThreadRef = map[string]any{"driver": driver, "nativeId": nativeID, "strength": "strong"}
		}
	}
	providerPayload := map[string]any{"id": providerThreadID, "driver": driver, "providerInstanceId": providerInstanceID, "providerSessionId": nil, "appThreadId": threadID, "ownerNodeId": nil, "nativeThreadRef": nativeThreadRef, "nativeConversationHeadRef": nil, "status": "idle", "firstRunOrdinal": nil, "lastRunOrdinal": nil, "handoffIds": []any{}, "forkedFrom": nil, "pendingBackgroundTasks": []any{}, "createdAt": thread.CreatedAt, "updatedAt": thread.UpdatedAt}
	events = append(events, makeEvent(thread, threadID, "provider-thread", "provider-thread.updated", thread.UpdatedAt, providerPayload, driver))
	plan := Plan{ThreadID: threadID, ProjectID: projectID, ProviderInstanceID: providerInstanceID, Events: events, Assets: history.Assets, Warnings: history.Warnings}
	if resumable {
		plan.Runtime = buildRuntimeBinding(thread, threadID, providerInstanceID, providerModel, modelOptions)
		if plan.Runtime == nil {
			return Plan{}, errors.New("v2: resumable import requires a supported native resume cursor")
		}
	}
	if createProject {
		payload := map[string]any{"projectId": projectID, "title": filepath.Base(thread.Workspace), "workspaceRoot": thread.Workspace, "defaultModelSelection": model, "scripts": []any{}, "createdAt": thread.CreatedAt, "updatedAt": thread.UpdatedAt}
		b, _ := json.Marshal(payload)
		cmd := uuid("t3-import:v2:project-command:" + thread.Workspace)
		plan.Project = &ProjectEvent{CommandID: cmd, AcceptedAt: thread.CreatedAt, EventID: uuid("t3-import:v2:project-event:" + thread.Workspace), ProjectID: projectID, OccurredAt: thread.CreatedAt, Payload: b}
	}
	return plan, nil
}

func nativeSessionID(thread domain.CanonicalThread) string {
	if thread.Source == domain.SourceCodex {
		if id, ok := thread.ResumeCursor["threadId"].(string); ok {
			return id
		}
	} else if thread.Source == domain.SourceClaude {
		if id, ok := thread.ResumeCursor["resume"].(string); ok {
			return id
		}
	}
	return ""
}

func buildRuntimeBinding(thread domain.CanonicalThread, threadID, providerInstanceID, model string, modelOptions map[string]any) *RuntimeBinding {
	nativeID := nativeSessionID(thread)
	if nativeID == "" || threadID == "" {
		return nil
	}
	cursor := make(map[string]any, len(thread.ResumeCursor)+1)
	for key, value := range thread.ResumeCursor {
		cursor[key] = value
	}
	if thread.Source == domain.SourceClaude {
		cursor["threadId"] = threadID
	}
	if model == "" {
		model = thread.Model
	}
	driver := driverFor(thread)
	selection := map[string]any{"instanceId": providerInstanceID, "model": model, "options": modelOptions}
	if modelOptions == nil {
		selection["options"] = map[string]any{}
	}
	payload := map[string]any{"cwd": thread.Workspace, "model": model, "activeTurnId": nil, "lastError": nil, "modelSelection": selection, "lastRuntimeEvent": "imported:" + driver, "lastRuntimeEventAt": thread.UpdatedAt}
	cursorJSON, _ := json.Marshal(cursor)
	payloadJSON, _ := json.Marshal(payload)
	providerName := "codex"
	if thread.Source == domain.SourceClaude {
		providerName = "claudeAgent"
	}
	return &RuntimeBinding{ThreadID: threadID, ProviderName: providerName, ProviderInstanceID: providerInstanceID, AdapterKey: providerName, LastSeenAt: thread.UpdatedAt, ResumeCursorJSON: string(cursorJSON), RuntimePayloadJSON: string(payloadJSON)}
}

func uuid(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x50
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
func stringsTrim(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "Untitled thread"
	}
	return s
}
func makeEvent(thread domain.CanonicalThread, threadID, key, kind, at string, payload map[string]any, driver string) Event {
	b, _ := json.Marshal(payload)
	return Event{ID: uuid("t3-import:v2:event:" + thread.SourceKey + ":" + key), Type: kind, ThreadID: threadID, Driver: driver, OccurredAt: at, Payload: b}
}

type encodedHistory struct {
	Events     []Event
	Assets     []assets.Asset
	Warnings   []string
	Activities int
}
type historyEntry struct {
	at, key string
	event   Event
}

func encodeHistory(thread domain.CanonicalThread, threadID, attachmentsDir string) (encodedHistory, error) {
	var result encodedHistory
	ordinal := 0
	for _, turn := range thread.Turns {
		var entries []historyEntry
		assistantIDs := map[string]bool{}
		var lastAssistant string
		hasFailure := false
		messages := append([]domain.CanonicalMessage{turn.User}, turn.Assistant...)
		for i, m := range messages {
			text, descriptors := m.Text, []assets.Descriptor(nil)
			if m.Role == "user" {
				var planned []assets.Asset
				var warnings []string
				text, descriptors, planned, warnings = assets.PlanMessage(m, threadID, attachmentsDir)
				result.Assets = append(result.Assets, planned...)
				result.Warnings = append(result.Warnings, warnings...)
			}
			mid := uuid("t3-import:v2:message:" + thread.SourceKey + ":" + m.SourceID)
			itemID := uuid("t3-import:v2:turn-item:" + thread.SourceKey + ":" + m.SourceID)
			mp := map[string]any{"createdBy": "agent", "creationSource": "server", "id": mid, "threadId": threadID, "runId": nil, "nodeId": nil, "role": m.Role, "text": text, "attachments": descriptors, "streaming": false, "createdAt": m.Timestamp, "updatedAt": m.Timestamp}
			if m.Role == "user" {
				mp["createdBy"] = "user"
			}
			status := "completed"
			if i == len(messages)-1 {
				if turn.Status == domain.TurnFailed {
					status = "failed"
				} else if turn.Status == domain.TurnInterrupted {
					status = "interrupted"
				}
			}
			base := itemBasePayload(threadID, itemID, 0, m.Timestamp, status)
			base["messageId"] = mid
			base["text"] = text
			if m.Role == "user" {
				base["createdBy"] = "user"
				base["creationSource"] = "server"
				base["type"] = "user_message"
				base["inputIntent"] = "turn_start"
				base["attachments"] = descriptors
			} else {
				base["type"] = "assistant_message"
				base["streaming"] = false
				lastAssistant = itemID
				assistantIDs[itemID] = true
			}
			entries = append(entries, historyEntry{m.Timestamp, m.SourceID, makeEvent(thread, threadID, "message:"+m.SourceID, "message.updated", m.Timestamp, mp, driverFor(thread))}, historyEntry{m.Timestamp, m.SourceID, makeEvent(thread, threadID, "item:"+m.SourceID, "turn-item.updated", m.Timestamp, base, driverFor(thread))})
		}
		for _, p := range turn.Plans {
			for _, ev := range planEvents(thread, threadID, p.SourceID, p.Timestamp, "proposed_plan", map[string]any{"markdown": p.Markdown}) {
				entries = append(entries, historyEntry{p.Timestamp, p.SourceID, ev})
			}
		}
		for _, a := range turn.Activities {
			if a.Kind == "context-window.updated" {
				continue
			}
			mapped, failed := activityEvents(thread, threadID, a)
			hasFailure = hasFailure || failed
			for _, ev := range mapped {
				entries = append(entries, historyEntry{a.Timestamp, a.SourceID, ev})
			}
		}
		if usage := latestUsage(turn.Activities); usage != nil {
			if summary := usageSummary(*usage, thread.Source); summary != "" {
				ev := timeline(thread, threadID, usage.SourceID, usage.Timestamp, 0, "completed", "system_notice", map[string]any{"message": summary})
				entries = append(entries, historyEntry{usage.Timestamp, usage.SourceID, ev})
			}
		}
		if turn.Status == domain.TurnFailed && !hasFailure {
			at := turn.User.Timestamp
			if len(turn.Assistant) > 0 {
				at = turn.Assistant[len(turn.Assistant)-1].Timestamp
			}
			if turn.CompletedAt != nil {
				at = *turn.CompletedAt
			}
			msg := ""
			if turn.TerminalError != nil {
				msg = *turn.TerminalError
			} else if turn.TerminalReason != nil {
				msg = *turn.TerminalReason
			}
			entries = append(entries, historyEntry{at, "terminal-failure", timeline(thread, threadID, turn.ID+":terminal-failure", at, 0, "failed", "error", map[string]any{"failure": map[string]any{"class": "provider_error", "message": errorText(msg), "code": nil, "retryable": nil}})})
		} else if turn.Status == domain.TurnInterrupted {
			at := turn.User.Timestamp
			if len(turn.Assistant) > 0 {
				at = turn.Assistant[len(turn.Assistant)-1].Timestamp
			}
			if turn.CompletedAt != nil {
				at = *turn.CompletedAt
			}
			reason := "The source turn was interrupted."
			if turn.TerminalReason != nil {
				reason = *turn.TerminalReason
			}
			entries = append(entries, historyEntry{at, "terminal-interruption", timeline(thread, threadID, turn.ID+":terminal-interruption", at, 0, "interrupted", "run_interrupt_result", map[string]any{"message": reason})})
		}
		sort.SliceStable(entries, func(i, j int) bool {
			if entries[i].at != entries[j].at {
				return entries[i].at < entries[j].at
			}
			return entries[i].key < entries[j].key
		})
		for _, entry := range entries {
			if entry.event.Type == "turn-item.updated" {
				var p map[string]any
				_ = json.Unmarshal(entry.event.Payload, &p)
				ordinal++
				p["ordinal"] = ordinal
				if p["type"] != "user_message" && p["type"] != "assistant_message" {
					result.Activities++
				}
				if turn.Status == domain.TurnFailed && lastAssistant != "" && assistantIDs[p["id"].(string)] && !hasFailure {
					p["status"] = "failed"
				}
				entry.event.Payload, _ = json.Marshal(p)
			}
			result.Events = append(result.Events, entry.event)
		}
	}
	return result, nil
}

func itemBasePayload(threadID, id string, ordinal int, at, status string) map[string]any {
	return map[string]any{"id": id, "threadId": threadID, "runId": nil, "nodeId": nil, "providerThreadId": nil, "providerTurnId": nil, "nativeItemRef": nil, "parentItemId": nil, "ordinal": ordinal, "status": status, "title": nil, "startedAt": at, "completedAt": at, "updatedAt": at}
}
func timeline(t domain.CanonicalThread, threadID, sourceID, at string, ordinal int, status, kind string, fields map[string]any) Event {
	id := uuid("t3-import:v2:turn-item:" + t.SourceKey + ":" + sourceID)
	p := itemBasePayload(threadID, id, ordinal, at, status)
	p["type"] = kind
	for k, v := range fields {
		p[k] = v
	}
	return makeEvent(t, threadID, "item:"+sourceID, "turn-item.updated", at, p, driverFor(t))
}
func planEvents(t domain.CanonicalThread, threadID, sourceID, at, kind string, body map[string]any) []Event {
	pid := uuid("t3-import:v2:plan:" + t.SourceKey + ":" + sourceID)
	node := uuid("t3-import:v2:node:" + t.SourceKey + ":" + sourceID)
	status := "completed"
	if kind == "todo_list" {
		if steps, ok := body["steps"].([]map[string]any); ok {
			for _, step := range steps {
				if step["status"] != "completed" {
					status = "active"
					break
				}
			}
		}
	}
	artifact := map[string]any{"id": pid, "threadId": threadID, "runId": nil, "nodeId": node, "status": status, "kind": kind}
	for k, v := range body {
		artifact[k] = v
	}
	fields := map[string]any{"planId": pid}
	for k, v := range body {
		fields[k] = v
	}
	if kind == "proposed_plan" {
		fields["streaming"] = false
	}
	return []Event{makeEvent(t, threadID, "plan:"+sourceID, "plan.updated", at, artifact, driverFor(t)), timeline(t, threadID, sourceID, at, 0, "completed", kind, fields)}
}

func activityEvents(t domain.CanonicalThread, threadID string, a domain.CanonicalActivity) ([]Event, bool) {
	p := a.Payload
	status := "completed"
	if p["status"] == "failed" || a.Tone == domain.ToneError {
		status = "failed"
	}
	switch a.Kind {
	case "reasoning.summary":
		return []Event{timeline(t, threadID, a.SourceID, a.Timestamp, 0, status, "reasoning", map[string]any{"text": stringify(valueOr(p["detail"], a.Summary)), "streaming": false})}, false
	case "turn.plan.updated":
		steps := planSteps(p["plan"])
		if len(steps) > 0 {
			body := map[string]any{"steps": steps}
			if s, ok := p["explanation"].(string); ok && s != "" {
				body["explanation"] = s
			}
			return planEvents(t, threadID, a.SourceID, a.Timestamp, "todo_list", body), false
		}
	case "context-compaction":
		summary := a.Summary
		if s, ok := p["summary"].(string); ok {
			summary = s
		}
		body := map[string]any{"driver": driverFor(t), "summary": summary}
		for _, k := range []string{"beforeTokenCount", "afterTokenCount"} {
			if n, ok := safeInteger(p[k]); ok {
				body[k] = n
			}
		}
		return []Event{timeline(t, threadID, a.SourceID, a.Timestamp, 0, status, "compaction", body)}, false
	case "tool.completed":
		item := sourceActivityItem(a)
		input := valueOr(item["input"], valueOr(item["arguments"], valueOr(item["command"], map[string]any{})))
		output := valueOr(item["output"], p["detail"])
		switch p["itemType"] {
		case "command_execution":
			body := map[string]any{"input": stringify(input)}
			if output != nil {
				body["output"] = stringify(output)
			}
			if status == "failed" {
				body["outputIndicatesFailure"] = true
			}
			return []Event{timeline(t, threadID, a.SourceID, a.Timestamp, 0, status, "command_execution", body)}, false
		case "web_search":
			body := map[string]any{}
			query := valueOr(item["query"], item["search_query"])
			if query != nil {
				body["patterns"] = []any{query}
			}
			if output != nil {
				results := item["results"]
				if results == nil {
					results = []any{}
				}
				body["results"] = results
			}
			return []Event{timeline(t, threadID, a.SourceID, a.Timestamp, 0, status, "web_search", body)}, false
		default:
			name := valueOr(item["name"], valueOr(p["title"], a.Summary))
			body := map[string]any{"toolName": name, "input": input}
			if output != nil {
				body["output"] = output
			}
			return []Event{timeline(t, threadID, a.SourceID, a.Timestamp, 0, status, "dynamic_tool", body)}, false
		}
	case "provider.error":
		return []Event{errorItem(t, threadID, a.SourceID, a.Timestamp, p["detail"], a.Summary)}, true
	case "context-window.updated":
		return nil, false
	default:
		if strings.Contains(a.Kind, "error") || a.Tone == domain.ToneError {
			return []Event{errorItem(t, threadID, a.SourceID, a.Timestamp, p["detail"], a.Summary)}, true
		}
		if a.Tone == domain.ToneApproval {
			prompt := valueOr(p["prompt"], valueOr(p["detail"], a.Summary))
			return []Event{timeline(t, threadID, a.SourceID, a.Timestamp, 0, status, "approval_request", map[string]any{"requestId": uuid("t3-import:v2:request:" + t.SourceKey + ":" + a.SourceID), "requestKind": "command_execution", "prompt": prompt})}, false
		}
		extra := ""
		if len(p) > 0 {
			extra = ": " + stringify(p)
		}
		return []Event{timeline(t, threadID, a.SourceID, a.Timestamp, 0, status, "system_notice", map[string]any{"message": a.Summary + extra})}, false
	}
	return nil, false
}
func errorItem(t domain.CanonicalThread, threadID, sourceID, at string, detail any, summary string) Event {
	return timeline(t, threadID, sourceID, at, 0, "failed", "error", map[string]any{"failure": map[string]any{"class": "provider_error", "message": errorText(valueOr(detail, summary)), "code": nil, "retryable": nil}})
}
func sourceActivityItem(a domain.CanonicalActivity) map[string]any {
	data, _ := a.Payload["data"].(map[string]any)
	item, _ := data["item"].(map[string]any)
	if item == nil {
		return map[string]any{}
	}
	return item
}
func valueOr(a, b any) any {
	if a == nil {
		return b
	}
	return a
}
func stringify(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

var sensitiveValue = regexp.MustCompile(`((?i)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+`)
var bearerValue = regexp.MustCompile(`(?i)\b(Bearer\s+)[A-Za-z0-9._~+/=-]+`)

func errorText(v any) string {
	s := strings.TrimSpace(stringify(v))
	if s == "" {
		s = "The source provider reported an error."
	}
	s = bearerValue.ReplaceAllString(s, "${1}[redacted]")
	s = sensitiveValue.ReplaceAllString(s, "${1}[redacted]")
	if len(s) > 4096 {
		s = s[:4095] + "…"
	}
	return s
}
func planSteps(v any) []map[string]any {
	raw, ok := v.([]any)
	if !ok {
		return nil
	}
	var out []map[string]any
	for i, value := range raw {
		row, ok := value.(map[string]any)
		if !ok {
			continue
		}
		text, _ := row["step"].(string)
		if strings.TrimSpace(text) == "" {
			text, _ = row["text"].(string)
		}
		if strings.TrimSpace(text) == "" {
			text, _ = row["title"].(string)
		}
		if strings.TrimSpace(text) == "" {
			continue
		}
		status := "pending"
		if row["status"] == "completed" {
			status = "completed"
		} else if row["status"] == "inProgress" || row["status"] == "running" {
			status = "running"
		}
		out = append(out, map[string]any{"id": fmt.Sprintf("step-%d", i+1), "text": text, "status": status})
	}
	return out
}
func latestUsage(activities []domain.CanonicalActivity) *domain.CanonicalActivity {
	var candidates []domain.CanonicalActivity
	for _, a := range activities {
		if a.Kind == "context-window.updated" {
			candidates = append(candidates, a)
		}
	}
	if len(candidates) == 0 {
		return nil
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].Timestamp != candidates[j].Timestamp {
			return candidates[i].Timestamp < candidates[j].Timestamp
		}
		return candidates[i].SourceID < candidates[j].SourceID
	})
	return &candidates[len(candidates)-1]
}
func usageSummary(a domain.CanonicalActivity, source domain.SourceName) string {
	keys := make([]string, 0)
	for key, v := range a.Payload {
		if _, ok := safeInteger(v); ok {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	if len(keys) == 0 {
		return ""
	}
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, fmt.Sprintf("%s=%v", key, a.Payload[key]))
	}
	return fmt.Sprintf("Historical %s token usage (%s): %s.", source, a.Timestamp, strings.Join(parts, ", "))
}
func safeInteger(v any) (int64, bool) {
	switch n := v.(type) {
	case int:
		return int64(n), n >= 0
	case int8:
		return int64(n), n >= 0
	case int16:
		return int64(n), n >= 0
	case int32:
		return int64(n), n >= 0
	case int64:
		return n, n >= 0
	case uint:
		return int64(n), n <= uint(^uint64(0)>>1)
	case uint64:
		return int64(n), n <= uint64(^uint64(0)>>1)
	case float64:
		if n >= 0 && n <= float64(^uint64(0)>>1) && n == float64(int64(n)) {
			return int64(n), true
		}
	}
	return 0, false
}
func driverFor(t domain.CanonicalThread) string {
	if t.Source == domain.SourceClaude {
		return "claudeAgent"
	}
	return "codex"
}

type StoredEvent struct {
	Event    Event
	Sequence int64
}

// SyncPlan describes a suffix to append to an already existing thread. The
// expected prefix is captured during inspection and checked again while the
// append transaction holds its write lock.
type SyncPlan struct {
	ThreadID, ProjectID, ProviderInstanceID string
	Expected                                []StoredEvent
	Events                                  []Event
	Runtime                                 *RuntimeBinding
}

// ReplacementTarget is an inspected old thread and its deterministic
// tombstone. Snapshotting the old stream prevents replacement after a target
// edit or concurrent write.
type ReplacementTarget struct {
	Expected  []StoredEvent
	Tombstone Event
}

// ReplacementPlan appends a new canonical thread and tombstones every old
// thread in one transaction. Activity is explicit because source settlement
// is owned by the app layer.
type ReplacementPlan struct {
	New                        Plan
	Old                        []ReplacementTarget
	SourceActive, TargetActive bool
}

// BuildReplacementPlan binds a freshly planned thread to inspected old
// histories. IDs are deterministic from the new thread and old thread IDs.
func BuildReplacementPlan(next Plan, old [][]StoredEvent, replacedAt string, sourceActive, targetActive bool) (ReplacementPlan, error) {
	if len(old) == 0 || replacedAt == "" || next.ThreadID == "" {
		return ReplacementPlan{}, errors.New("v2: replacement requires a new plan, old histories and timestamp")
	}
	r := ReplacementPlan{New: next, SourceActive: sourceActive, TargetActive: targetActive}
	seen := map[string]bool{}
	for _, history := range old {
		if len(history) == 0 || history[0].Event.Type != "thread.created" {
			return ReplacementPlan{}, errors.New("v2: ambiguous replacement history")
		}
		threadID := history[0].Event.ThreadID
		for _, row := range history {
			if row.Event.Type == "thread.deleted" {
				return ReplacementPlan{}, errors.New("v2: replacement target is already deleted")
			}
		}
		if threadID == "" || threadID == next.ThreadID || seen[threadID] {
			return ReplacementPlan{}, errors.New("v2: ambiguous replacement target mapping")
		}
		seen[threadID] = true
		payload, _ := json.Marshal(map[string]any{"threadId": threadID, "deletedAt": replacedAt})
		r.Old = append(r.Old, ReplacementTarget{Expected: history, Tombstone: Event{ID: uuid("t3-import:v2:replacement-deleted:" + next.ThreadID + ":" + threadID), Type: "thread.deleted", ThreadID: threadID, OccurredAt: replacedAt, Payload: payload, Metadata: json.RawMessage(`{"source":"t3-import","replacedByThreadId":"` + next.ThreadID + `"}`)}})
	}
	return r, nil
}

// AppendReplacement writes the new plan and all old-thread tombstones as one
// atomic SQLite operation. The app must set activity flags from its source and
// runtime inspection before calling this API.
func AppendReplacement(ctx context.Context, db *sql.DB, plan ReplacementPlan) ([]StoredEvent, error) {
	if db == nil || plan.SourceActive || plan.TargetActive {
		return nil, errors.New("v2: active source or target prevents replacement")
	}
	if plan.New.ThreadID == "" || plan.New.ProjectID == "" || plan.New.ProviderInstanceID == "" || len(plan.New.Events) == 0 || len(plan.Old) == 0 {
		return nil, errors.New("v2: incomplete replacement plan")
	}
	if plan.New.Events[0].Type != "thread.created" || plan.New.Events[0].ThreadID != plan.New.ThreadID {
		return nil, errors.New("v2: replacement plan must begin with its new thread")
	}
	oldIDs := map[string]bool{}
	for _, old := range plan.Old {
		if len(old.Expected) == 0 {
			return nil, errors.New("v2: empty replacement target snapshot")
		}
		id := old.Expected[0].Event.ThreadID
		if id == "" || id == plan.New.ThreadID || oldIDs[id] || old.Tombstone.ThreadID != id {
			return nil, errors.New("v2: ambiguous replacement target mapping")
		}
		oldIDs[id] = true
	}
	if _, err := targetschema.Validate(ctx, db); err != nil {
		return nil, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	for _, old := range plan.Old {
		if err := assertSnapshotTx(ctx, tx, old.Expected); err != nil {
			return nil, err
		}
		if old.Tombstone.Type != "thread.deleted" || old.Tombstone.ThreadID == "" || !json.Valid(old.Tombstone.Payload) {
			return nil, errors.New("v2: invalid replacement tombstone")
		}
	}
	var exists int
	if err = tx.QueryRowContext(ctx, "SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=?", plan.New.ThreadID).Scan(&exists); err == nil {
		return nil, errors.New("v2: replacement thread already exists")
	} else if err != sql.ErrNoRows {
		return nil, err
	}
	if plan.New.Project != nil {
		if plan.New.Project.ProjectID != plan.New.ProjectID || !json.Valid(plan.New.Project.Payload) {
			return nil, errors.New("v2: invalid replacement project")
		}
		if err = appendProjectTx(ctx, tx, *plan.New.Project); err != nil {
			return nil, err
		}
	} else {
		if err = tx.QueryRowContext(ctx, "SELECT 1 FROM projection_projects WHERE project_id=? AND deleted_at IS NULL", plan.New.ProjectID).Scan(&exists); err != nil {
			return nil, errors.New("v2: replacement project missing or deleted")
		}
	}
	var out []StoredEvent
	for _, e := range plan.New.Events {
		stored, err := appendThreadEventTx(ctx, tx, e, plan.New.ProviderInstanceID, plan.New.ProjectID)
		if err != nil {
			return nil, err
		}
		out = append(out, stored)
	}
	for _, old := range plan.Old {
		stored, err := appendThreadEventTx(ctx, tx, old.Tombstone, plan.New.ProviderInstanceID, plan.New.ProjectID)
		if err != nil {
			return nil, err
		}
		out = append(out, stored)
	}
	if plan.New.Runtime != nil {
		if err = upsertRuntimeTx(ctx, tx, *plan.New.Runtime); err != nil {
			return nil, err
		}
	}
	for id := range oldIDs {
		if _, err = tx.ExecContext(ctx, "DELETE FROM provider_session_runtime WHERE thread_id=?", id); err != nil {
			return nil, err
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE orchestration_v2_projection_metadata SET last_sequence=(SELECT COALESCE(MAX(sequence),0) FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread'),updated_at=CURRENT_TIMESTAMP WHERE projection_name='thread-projections'"); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}

func assertSnapshotTx(ctx context.Context, tx *sql.Tx, expected []StoredEvent) error {
	if len(expected) == 0 {
		return errors.New("v2: empty replacement snapshot")
	}
	id := expected[0].Event.ThreadID
	rows, err := tx.QueryContext(ctx, "SELECT sequence,event_id,event_type,stream_id,occurred_at,payload_json,metadata_json FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? ORDER BY sequence", id)
	if err != nil {
		return err
	}
	defer rows.Close()
	i := 0
	for rows.Next() {
		var got StoredEvent
		var payload, meta string
		if err = rows.Scan(&got.Sequence, &got.Event.ID, &got.Event.Type, &got.Event.ThreadID, &got.Event.OccurredAt, &payload, &meta); err != nil {
			return err
		}
		got.Event.Payload = json.RawMessage(payload)
		got.Event.Metadata = json.RawMessage(meta)
		if i >= len(expected) {
			return errors.New("v2: target changed since replacement inspection")
		}
		a, _ := StableEventJSON(got.Event)
		b, e := StableEventJSON(expected[i].Event)
		if e != nil || string(a) != string(b) {
			return errors.New("v2: target changed since replacement inspection")
		}
		i++
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if i != len(expected) {
		return errors.New("v2: target changed since replacement inspection")
	}
	return nil
}

func appendProjectTx(ctx context.Context, tx *sql.Tx, p ProjectEvent) error {
	var exists int
	if err := tx.QueryRowContext(ctx, "SELECT 1 FROM projection_projects WHERE project_id=?", p.ProjectID).Scan(&exists); err == nil {
		return errors.New("v2: replacement project already exists")
	} else if err != sql.ErrNoRows {
		return err
	}
	var seq, sv int64
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(sequence),0)+1 FROM orchestration_events").Scan(&seq); err != nil {
		return err
	}
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(stream_version),-1)+1 FROM orchestration_events WHERE aggregate_kind='project' AND stream_id=?", p.ProjectID).Scan(&sv); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json,application_event_version) VALUES(?,?,'project',?,?, 'project.created',?,?,NULL,NULL,'client',?,'{}',2)`, seq, p.EventID, p.ProjectID, sv, p.OccurredAt, p.CommandID, string(p.Payload)); err != nil {
		return err
	}
	var body map[string]any
	_ = json.Unmarshal(p.Payload, &body)
	dm, _ := json.Marshal(body["defaultModelSelection"])
	scripts, _ := json.Marshal(body["scripts"])
	_, err := tx.ExecContext(ctx, `INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at,deleted_at,default_model_selection_json) VALUES(?,?,?,?,?,?,NULL,?)`, p.ProjectID, body["title"], body["workspaceRoot"], string(scripts), body["createdAt"], body["updatedAt"], string(dm))
	return err
}

func appendThreadEventTx(ctx context.Context, tx *sql.Tx, e Event, provider, project string) (StoredEvent, error) {
	if e.ID == "" || e.ThreadID == "" || e.OccurredAt == "" || !json.Valid(e.Payload) || (!supported(e.Type) && e.Type != "thread.deleted") {
		return StoredEvent{}, errors.New("v2: invalid replacement event")
	}
	var seq, sv int64
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(sequence),0)+1 FROM orchestration_events").Scan(&seq); err != nil {
		return StoredEvent{}, err
	}
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(stream_version),-1)+1 FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=?", e.ThreadID).Scan(&sv); err != nil {
		return StoredEvent{}, err
	}
	meta := string(e.Metadata)
	if meta == "" {
		meta = "{}"
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json,application_event_version) VALUES(?,?,'thread',?,?,?,?,NULL,NULL,NULL,'server',?,?,2)`, seq, e.ID, e.ThreadID, sv, e.Type, e.OccurredAt, string(e.Payload), meta); err != nil {
		return StoredEvent{}, err
	}
	if e.Type == "thread.deleted" {
		var p map[string]any
		_ = json.Unmarshal(e.Payload, &p)
		if p["threadId"] != e.ThreadID {
			return StoredEvent{}, errors.New("v2: tombstone thread identity mismatch")
		}
		if _, err := tx.ExecContext(ctx, "UPDATE orchestration_v2_projection_threads SET deleted_at=?,payload_json=json_set(payload_json,'$.deletedAt',?) WHERE thread_id=?", p["deletedAt"], p["deletedAt"], e.ThreadID); err != nil {
			return StoredEvent{}, err
		}
	} else if err := projectEvent(ctx, tx, e, provider, project); err != nil {
		return StoredEvent{}, err
	}
	return StoredEvent{Event: e, Sequence: seq}, nil
}

// InspectThread returns the pinned event stream for a thread and its target
// identity. It rejects absent or multiply-created threads so callers cannot
// infer a safe continuation from a partial stream.
func InspectThread(ctx context.Context, db *sql.DB, threadID string) ([]StoredEvent, error) {
	rows, err := Read(ctx, db, threadID)
	if err != nil {
		return nil, err
	}
	created := 0
	for _, row := range rows {
		if row.Event.Type == "thread.created" {
			created++
		}
	}
	if len(rows) == 0 || created != 1 || rows[0].Event.Type != "thread.created" {
		return nil, fmt.Errorf("v2: ambiguous thread history for %s", threadID)
	}
	return rows, nil
}

// BuildSyncPlan permits append only when imported history is an exact
// deterministic prefix of a freshly built source plan. It verifies provider
// identity separately and ignores mutable thread/provider metadata. Any source
// history divergence or target-only history event fails closed.
func BuildSyncPlan(existing []StoredEvent, full Plan) (SyncPlan, error) {
	if len(existing) == 0 || full.ThreadID == "" || existing[0].Event.ThreadID != full.ThreadID {
		return SyncPlan{}, errors.New("v2: target history is not a source prefix")
	}
	var sourceHistory []Event
	var providerEvent *Event
	for i := range full.Events {
		event := full.Events[i]
		if event.ThreadID != full.ThreadID {
			return SyncPlan{}, errors.New("v2: source plan contains a different thread")
		}
		if event.Type == "provider-thread.updated" {
			if providerEvent != nil {
				return SyncPlan{}, errors.New("v2: source plan contains multiple provider bindings")
			}
			providerEvent = &event
			continue
		}
		sourceHistory = append(sourceHistory, event)
	}
	if len(sourceHistory) == 0 || sourceHistory[0].Type != "thread.created" || providerEvent == nil {
		return SyncPlan{}, errors.New("v2: source plan is missing its thread or provider binding")
	}

	var targetHistory []StoredEvent
	providerEvents := 0
	for _, row := range existing {
		if row.Event.Type == "provider-thread.updated" {
			providerEvents++
			if err := sameProviderIdentity(row.Event, *providerEvent); err != nil {
				return SyncPlan{}, fmt.Errorf("v2: provider binding changed: %w", err)
			}
			continue
		}
		targetHistory = append(targetHistory, row)
	}
	if providerEvents == 0 || len(targetHistory) > len(sourceHistory) {
		return SyncPlan{}, errors.New("v2: target history is not a source prefix")
	}
	for i, row := range targetHistory {
		equal, err := sameSyncHistoryEvent(row.Event, sourceHistory[i])
		if err != nil {
			return SyncPlan{}, err
		}
		if !equal {
			return SyncPlan{}, fmt.Errorf("v2: source diverged from target at history event %d", i)
		}
	}
	return SyncPlan{ThreadID: full.ThreadID, ProjectID: full.ProjectID, ProviderInstanceID: full.ProviderInstanceID, Expected: existing, Events: append([]Event(nil), sourceHistory[len(targetHistory):]...), Runtime: full.Runtime}, nil
}

func sameSyncHistoryEvent(got, want Event) (bool, error) {
	if got.Type != "thread.created" {
		gotJSON, err := StableEventJSON(got)
		if err != nil {
			return false, err
		}
		wantJSON, err := StableEventJSON(want)
		return string(gotJSON) == string(wantJSON), err
	}
	var gotPayload, wantPayload map[string]any
	if err := json.Unmarshal(got.Payload, &gotPayload); err != nil {
		return false, err
	}
	if err := json.Unmarshal(want.Payload, &wantPayload); err != nil {
		return false, err
	}
	// These fields describe current source metadata; they may advance while the
	// imported message and turn history remains an exact prefix.
	for _, key := range []string{"title", "updatedAt", "settledAt"} {
		delete(gotPayload, key)
		delete(wantPayload, key)
	}
	got.Payload, _ = json.Marshal(gotPayload)
	want.Payload, _ = json.Marshal(wantPayload)
	gotJSON, err := StableEventJSON(got)
	if err != nil {
		return false, err
	}
	wantJSON, err := StableEventJSON(want)
	return string(gotJSON) == string(wantJSON), err
}

func sameProviderIdentity(got, want Event) error {
	var gotPayload, wantPayload map[string]any
	if err := json.Unmarshal(got.Payload, &gotPayload); err != nil {
		return err
	}
	if err := json.Unmarshal(want.Payload, &wantPayload); err != nil {
		return err
	}
	for _, key := range []string{"id", "appThreadId", "driver", "providerInstanceId"} {
		if gotPayload[key] != wantPayload[key] {
			return fmt.Errorf("provider field %q does not match the source", key)
		}
	}
	gotNative, _ := json.Marshal(gotPayload["nativeThreadRef"])
	wantNative, _ := json.Marshal(wantPayload["nativeThreadRef"])
	if string(gotNative) != string(wantNative) {
		return errors.New("provider native-thread reference does not match the source")
	}
	if got.ThreadID != want.ThreadID || gotPayload["id"] == nil {
		return errors.New("provider thread identity does not match the source")
	}
	return nil
}

// AppendSync atomically appends a previously inspected source suffix. The
// complete thread stream must still equal the inspected snapshot.
func AppendSync(ctx context.Context, db *sql.DB, plan SyncPlan) ([]StoredEvent, error) {
	if db == nil || plan.ThreadID == "" || plan.ProjectID == "" || plan.ProviderInstanceID == "" {
		return nil, errors.New("v2: incomplete sync plan")
	}
	if len(plan.Events) == 0 {
		return nil, nil
	}
	if _, err := targetschema.Validate(ctx, db); err != nil {
		return nil, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var stream []Event
	rows, err := tx.QueryContext(ctx, "SELECT sequence,event_id,event_type,stream_id,occurred_at,payload_json,metadata_json FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? ORDER BY sequence", plan.ThreadID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var s StoredEvent
		var payload, meta string
		if err = rows.Scan(&s.Sequence, &s.Event.ID, &s.Event.Type, &s.Event.ThreadID, &s.Event.OccurredAt, &payload, &meta); err != nil {
			rows.Close()
			return nil, err
		}
		s.Event.Payload = json.RawMessage(payload)
		s.Event.Metadata = json.RawMessage(meta)
		stream = append(stream, s.Event)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(stream) != len(plan.Expected) {
		return nil, errors.New("v2: target changed since sync inspection")
	}
	for i, got := range stream {
		a, _ := StableEventJSON(got)
		b, e := StableEventJSON(plan.Expected[i].Event)
		if e != nil || string(a) != string(b) {
			return nil, errors.New("v2: target changed since sync inspection")
		}
	}
	var project string
	if err = tx.QueryRowContext(ctx, "SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id=?", plan.ThreadID).Scan(&project); err != nil || project != plan.ProjectID {
		return nil, errors.New("v2: target thread/project mismatch")
	}
	stored := make([]StoredEvent, 0, len(plan.Events))
	for _, e := range plan.Events {
		if e.ThreadID != plan.ThreadID || e.ID == "" || !supported(e.Type) || !json.Valid(e.Payload) {
			return nil, errors.New("v2: invalid sync event")
		}
		var seq, sv int64
		if err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(sequence),0)+1 FROM orchestration_events").Scan(&seq); err != nil {
			return nil, err
		}
		if err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(stream_version),-1)+1 FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=?", plan.ThreadID).Scan(&sv); err != nil {
			return nil, err
		}
		meta := string(e.Metadata)
		if meta == "" {
			meta = "{}"
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json,application_event_version) VALUES(?,?,'thread',?,?,?,?,NULL,NULL,NULL,'server',?,?,2)`, seq, e.ID, plan.ThreadID, sv, e.Type, e.OccurredAt, string(e.Payload), meta); err != nil {
			return nil, err
		}
		if err = projectEvent(ctx, tx, e, plan.ProviderInstanceID, plan.ProjectID); err != nil {
			return nil, err
		}
		stored = append(stored, StoredEvent{Event: e, Sequence: seq})
	}
	if plan.Runtime != nil {
		if err = upsertRuntimeTx(ctx, tx, *plan.Runtime); err != nil {
			return nil, err
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE orchestration_v2_projection_metadata SET last_sequence=(SELECT COALESCE(MAX(sequence),0) FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread'),updated_at=CURRENT_TIMESTAMP WHERE projection_name='thread-projections'"); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return stored, nil
}

// AssignAppendOrdinals places supplemental or source continuation items after
// every item already projected for a thread, while keeping their event order.
func AssignAppendOrdinals(ctx context.Context, db *sql.DB, threadID string, events []Event) error {
	if db == nil || threadID == "" {
		return errors.New("v2: database and thread ID are required to assign sync ordinals")
	}
	var ordinal int64
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(MAX(ordinal),0) FROM orchestration_v2_projection_turn_items WHERE thread_id=?`, threadID).Scan(&ordinal); err != nil {
		return err
	}
	for index := range events {
		if events[index].Type != "turn-item.updated" {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(events[index].Payload, &payload); err != nil {
			return err
		}
		ordinal++
		payload["ordinal"] = ordinal
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		events[index].Payload = encoded
	}
	return nil
}

func validateProfile(ctx context.Context, db interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}) error {
	rows, err := db.QueryContext(ctx, "SELECT migration_id,name FROM effect_sql_migrations WHERE migration_id IN (55,61)")
	if err != nil {
		return fmt.Errorf("v2: read migrations: %w", err)
	}
	defer rows.Close()
	found := map[int]string{}
	for rows.Next() {
		var id int
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return err
		}
		found[id] = name
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if found[55] != "OrchestrationV2" || found[61] != "PullRequestReviewGuides" {
		return fmt.Errorf("v2: unsupported T3 profile: expected pinned migrations 55/61")
	}
	rows, err = db.QueryContext(ctx, "SELECT name FROM sqlite_master WHERE type='table'")
	if err != nil {
		return fmt.Errorf("v2: inspect tables: %w", err)
	}
	defer rows.Close()
	var names = map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return err
		}
		names[n] = true
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, n := range []string{"orchestration_events", "orchestration_v2_projection_metadata", "orchestration_v2_projection_threads", "orchestration_v2_projection_messages", "orchestration_v2_projection_turn_items", "orchestration_v2_projection_plans", "orchestration_v2_projection_provider_threads"} {
		if !names[n] {
			return fmt.Errorf("v2: unsupported T3 profile: missing %s", n)
		}
	}
	if !names["projection_projects"] {
		return fmt.Errorf("v2: unsupported T3 profile: missing projection_projects")
	}
	return nil
}

// Append writes one thread's importer event batch and native read models in a
// single transaction. Events must carry the TS event IDs and fully formed
// payloads; unsupported event types fail before any row is changed.
func Append(ctx context.Context, db *sql.DB, providerInstanceID, projectID string, events []Event) ([]StoredEvent, error) {
	return appendBatch(ctx, db, providerInstanceID, projectID, nil, nil, events)
}

// AppendPlan atomically creates its optional project and appends the thread.
func AppendPlan(ctx context.Context, db *sql.DB, plan Plan) ([]StoredEvent, error) {
	return appendBatch(ctx, db, plan.ProviderInstanceID, plan.ProjectID, plan.Project, plan.Runtime, plan.Events)
}

func appendBatch(ctx context.Context, db *sql.DB, providerInstanceID, projectID string, projectCreate *ProjectEvent, runtimeBinding *RuntimeBinding, events []Event) ([]StoredEvent, error) {
	if db == nil || providerInstanceID == "" || projectID == "" || len(events) == 0 {
		return nil, errors.New("v2: db, provider, project and events are required")
	}
	threadID := events[0].ThreadID
	if threadID == "" {
		return nil, errors.New("v2: empty thread ID")
	}
	seen := map[string]bool{}
	createCount := 0
	for _, e := range events {
		if e.ID == "" || e.ThreadID != threadID || e.OccurredAt == "" || seen[e.ID] {
			return nil, errors.New("v2: malformed or duplicate event identity")
		}
		seen[e.ID] = true
		if !supported(e.Type) {
			return nil, fmt.Errorf("v2: unsupported event type %q", e.Type)
		}
		if e.Type == "thread.created" {
			createCount++
		}
		if !json.Valid(e.Payload) {
			return nil, fmt.Errorf("v2: invalid payload for %s", e.ID)
		}
	}
	if createCount != 1 || events[0].Type != "thread.created" {
		return nil, errors.New("v2: thread batch must start with exactly one thread.created event")
	}
	if _, err := targetschema.Validate(ctx, db); err != nil {
		return nil, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var project string
	err = tx.QueryRowContext(ctx, "SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id=?", threadID).Scan(&project)
	if err == nil {
		return nil, fmt.Errorf("v2: thread %s already exists", threadID)
	}
	if err != sql.ErrNoRows {
		return nil, err
	}
	if projectCreate != nil {
		var exists int
		if err = tx.QueryRowContext(ctx, "SELECT 1 FROM projection_projects WHERE project_id=?", projectID).Scan(&exists); err == nil {
			return nil, errors.New("v2: project already exists")
		}
		if err != sql.ErrNoRows {
			return nil, err
		}
		if projectCreate.ProjectID != projectID || !json.Valid(projectCreate.Payload) {
			return nil, errors.New("v2: invalid project event")
		}
		var seq, sv int64
		if err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(sequence),0)+1 FROM orchestration_events").Scan(&seq); err != nil {
			return nil, err
		}
		if err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(stream_version),-1)+1 FROM orchestration_events WHERE aggregate_kind='project' AND stream_id=?", projectID).Scan(&sv); err != nil {
			return nil, err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json,application_event_version) VALUES(?,?,'project',?,?, 'project.created',?,?,NULL,NULL,'client',?,'{}',2)`, seq, projectCreate.EventID, projectID, sv, projectCreate.OccurredAt, projectCreate.CommandID, string(projectCreate.Payload))
		if err != nil {
			return nil, err
		}
		var payload map[string]any
		_ = json.Unmarshal(projectCreate.Payload, &payload)
		defaultModel, _ := json.Marshal(payload["defaultModelSelection"])
		scripts, _ := json.Marshal(payload["scripts"])
		_, err = tx.ExecContext(ctx, `INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at,deleted_at,default_model_selection_json) VALUES(?,?,?,?,?,?,NULL,?)`, projectID, payload["title"], payload["workspaceRoot"], string(scripts), payload["createdAt"], payload["updatedAt"], string(defaultModel))
		if err != nil {
			return nil, err
		}
	} else {
		var projectExists int
		if err = tx.QueryRowContext(ctx, "SELECT 1 FROM projection_projects WHERE project_id=? AND deleted_at IS NULL", projectID).Scan(&projectExists); err != nil {
			if err == sql.ErrNoRows {
				return nil, fmt.Errorf("v2: project %s is missing or deleted", projectID)
			}
			return nil, fmt.Errorf("v2: read project: %w", err)
		}
	}
	stored := make([]StoredEvent, 0, len(events))
	for _, e := range events {
		var existing string
		err = tx.QueryRowContext(ctx, "SELECT payload_json FROM orchestration_events WHERE event_id=?", e.ID).Scan(&existing)
		if err == nil {
			return nil, fmt.Errorf("v2: event ID conflict %s", e.ID)
		}
		if err != sql.ErrNoRows {
			return nil, err
		}
		var seq, sv int64
		if err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(sequence),0)+1 FROM orchestration_events").Scan(&seq); err != nil {
			return nil, err
		}
		if err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(stream_version),-1)+1 FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=?", threadID).Scan(&sv); err != nil {
			return nil, err
		}
		payload := string(e.Payload)
		metadata := string(e.Metadata)
		if metadata == "" {
			metadata = "{}"
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json,application_event_version) VALUES(?,?,'thread',?,?,?,?,NULL,NULL,NULL,'server',?,?,2)`, seq, e.ID, threadID, sv, e.Type, e.OccurredAt, payload, metadata)
		if err != nil {
			return nil, fmt.Errorf("v2: append event %s: %w", e.ID, err)
		}
		if err = projectEvent(ctx, tx, e, providerInstanceID, projectID); err != nil {
			return nil, fmt.Errorf("v2: project event %s: %w", e.ID, err)
		}
		stored = append(stored, StoredEvent{Event: e, Sequence: seq})
	}
	if runtimeBinding != nil {
		if err = upsertRuntimeTx(ctx, tx, *runtimeBinding); err != nil {
			return nil, err
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE orchestration_v2_projection_metadata SET last_sequence=(SELECT COALESCE(MAX(sequence),0) FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread'),updated_at=CURRENT_TIMESTAMP WHERE projection_name='thread-projections'"); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return stored, nil
}

func upsertRuntimeTx(ctx context.Context, tx *sql.Tx, runtime RuntimeBinding) error {
	if runtime.ThreadID == "" || runtime.ProviderName == "" || runtime.AdapterKey == "" || runtime.LastSeenAt == "" || !json.Valid([]byte(runtime.ResumeCursorJSON)) || !json.Valid([]byte(runtime.RuntimePayloadJSON)) {
		return errors.New("v2: invalid provider runtime binding")
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO provider_session_runtime(thread_id,provider_name,provider_instance_id,adapter_key,runtime_mode,status,last_seen_at,resume_cursor_json,runtime_payload_json) VALUES(?,?,?,?,?,'stopped',?,?,?) ON CONFLICT(thread_id) DO UPDATE SET provider_name=excluded.provider_name,provider_instance_id=excluded.provider_instance_id,adapter_key=excluded.adapter_key,runtime_mode=excluded.runtime_mode,status=excluded.status,last_seen_at=excluded.last_seen_at,resume_cursor_json=excluded.resume_cursor_json,runtime_payload_json=excluded.runtime_payload_json`, runtime.ThreadID, runtime.ProviderName, runtime.ProviderInstanceID, runtime.AdapterKey, "full-access", runtime.LastSeenAt, runtime.ResumeCursorJSON, runtime.RuntimePayloadJSON)
	return err
}

func supported(t string) bool {
	switch t {
	case "thread.created", "message.updated", "turn-item.updated", "plan.updated", "provider-thread.updated":
		return true
	}
	return false
}
func projectEvent(ctx context.Context, tx *sql.Tx, e Event, provider, project string) error {
	var p map[string]any
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return err
	}
	id, _ := p["id"].(string)
	tid, _ := p["threadId"].(string)
	if tid != "" && tid != e.ThreadID {
		return errors.New("payload threadId mismatch")
	}
	updated, _ := p["updatedAt"].(string)
	created, _ := p["createdAt"].(string)
	if updated == "" {
		updated = e.OccurredAt
	}
	if created == "" {
		created = e.OccurredAt
	}
	switch e.Type {
	case "thread.created":
		if id != e.ThreadID || p["projectId"] != project {
			return errors.New("thread identity/project mismatch")
		}
		providerID, _ := p["providerInstanceId"].(string)
		title, _ := p["title"].(string)
		runtime, _ := p["runtimeMode"].(string)
		interaction, _ := p["interactionMode"].(string)
		active, _ := p["activeProviderThreadId"].(string)
		b, _ := p["createdBy"].(string)
		_ = b
		_, err := tx.ExecContext(ctx, `INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,active_provider_thread_id,created_at,updated_at,archived_at,deleted_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)`, id, project, title, providerID, providerID, runtime, interaction, active, created, updated, e.Payload)
		return err
	case "message.updated":
		role, _ := p["role"].(string)
		run := nullable(p["runId"])
		node := nullable(p["nodeId"])
		stream := 0
		if p["streaming"] == true {
			stream = 1
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id,node_id,role,streaming,created_at,updated_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?)`, id, e.ThreadID, run, node, role, stream, created, updated, e.Payload)
		return err
	case "turn-item.updated":
		_, err := tx.ExecContext(ctx, `INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,parent_item_id,ordinal,type,status,updated_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, id, e.ThreadID, nullable(p["runId"]), nullable(p["nodeId"]), nullable(p["providerThreadId"]), nullable(p["providerTurnId"]), nullable(p["parentItemId"]), p["ordinal"], p["type"], p["status"], updated, e.Payload)
		return err
	case "plan.updated":
		_, err := tx.ExecContext(ctx, `INSERT INTO orchestration_v2_projection_plans(plan_id,thread_id,run_id,node_id,kind,status,payload_json) VALUES(?,?,?,?,?,?,?)`, id, e.ThreadID, nullable(p["runId"]), nullable(p["nodeId"]), p["kind"], p["status"], e.Payload)
		return err
	case "provider-thread.updated":
		if p["appThreadId"] != e.ThreadID {
			return errors.New("provider thread appThreadId mismatch")
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,owner_node_id,provider,driver,provider_instance_id,provider_session_id,status,first_run_ordinal,last_run_ordinal,updated_at,payload_json) VALUES(?,?,NULL,?,?,?,?,?,?,?, ?,?) ON CONFLICT(provider_thread_id) DO UPDATE SET thread_id=excluded.thread_id,owner_node_id=NULL,provider=excluded.provider,driver=excluded.driver,provider_instance_id=excluded.provider_instance_id,provider_session_id=excluded.provider_session_id,status=excluded.status,first_run_ordinal=excluded.first_run_ordinal,last_run_ordinal=excluded.last_run_ordinal,updated_at=excluded.updated_at,payload_json=excluded.payload_json`, id, e.ThreadID, provider, p["driver"], provider, nullable(p["providerSessionId"]), p["status"], nullable(p["firstRunOrdinal"]), nullable(p["lastRunOrdinal"]), updated, e.Payload); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE orchestration_v2_projection_threads SET active_provider_thread_id=?,updated_at=?,payload_json=json_set(payload_json,'$.activeProviderThreadId',?,'$.updatedAt',?) WHERE thread_id=?`, id, updated, id, updated, e.ThreadID); err != nil {
			return err
		}
		return nil
	}
	return errors.New("unsupported event")
}
func nullable(v any) any {
	if v == nil {
		return nil
	}
	return v
}

// Read returns events in native global sequence order for the requested thread.
func Read(ctx context.Context, db *sql.DB, threadID string) ([]StoredEvent, error) {
	if db == nil || threadID == "" {
		return nil, errors.New("v2: db and thread ID are required")
	}
	if _, err := targetschema.Validate(ctx, db); err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, "SELECT sequence,event_id,event_type,stream_id,occurred_at,payload_json,metadata_json FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? ORDER BY sequence", threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StoredEvent
	for rows.Next() {
		var s StoredEvent
		var payload, meta string
		if err := rows.Scan(&s.Sequence, &s.Event.ID, &s.Event.Type, &s.Event.ThreadID, &s.Event.OccurredAt, &payload, &meta); err != nil {
			return nil, err
		}
		s.Event.Payload = json.RawMessage(payload)
		s.Event.Metadata = json.RawMessage(meta)
		out = append(out, s)
	}
	return out, rows.Err()
}

// StableEventJSON is useful to compare persisted envelopes during recovery.
func StableEventJSON(e Event) ([]byte, error) {
	// Snapshot comparison includes events written by T3's native runtime, which
	// are outside this package's append allowlist. Keep the writer guard in
	// appendBatch/AppendSync while allowing opaque, valid envelopes in snapshots.
	if e.Type == "" || e.ID == "" || e.ThreadID == "" || !json.Valid(e.Payload) {
		return nil, errors.New("v2: invalid event")
	}
	var payload any
	if err := json.Unmarshal(e.Payload, &payload); err != nil {
		return nil, err
	}
	p, _ := json.Marshal(payload)
	return json.Marshal(struct {
		ID, Type, ThreadID, OccurredAt string
		Payload                        json.RawMessage
	}{e.ID, e.Type, e.ThreadID, e.OccurredAt, p})
}
