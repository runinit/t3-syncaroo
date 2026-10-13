// Package legacy implements the database-only operations for T3 schema
// migrations 40 through 53. Runtime checks, backups, ledgers, and file assets
// belong to the caller.
package legacy

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
	"runtime"
	"sort"
	"strings"

	"github.com/CarlosGtrz/t3-import/internal/checkpoint"
	"github.com/CarlosGtrz/t3-import/internal/domain"
	"github.com/CarlosGtrz/t3-import/internal/target/assets"
)

var supported = map[int]bool{40: true, 41: true, 42: true, 43: true, 44: true, 45: true, 46: true, 47: true, 48: true, 49: true, 50: true, 51: true, 52: true, 53: true}

type Provider struct {
	ProviderName, InstanceID, AdapterKey, Model string
	Options                                     []map[string]any
}
type Target struct {
	TargetID, ProjectID, ThreadID, IdentitySeed string
	Workspace, AttachmentsDir                   string
	CreateProject                               bool
	Migration                                   int
}
type Event struct {
	EventID, AggregateKind, StreamID, Type, OccurredAt, ActorKind string
	Payload, Metadata                                             map[string]any
	Key                                                           string
}
type Plan struct {
	Target    Target
	Thread    domain.CanonicalThread
	Provider  Provider
	Events    []Event
	Assets    []assets.Asset
	Warnings  []string
	Resumable bool
}
type Preview struct {
	Exists          bool
	AlreadyImported bool
	Migration       int
	EventCount      int
	Turns           int
}

func Migration(ctx context.Context, db *sql.DB) (int, error) {
	var n int
	if err := db.QueryRowContext(ctx, "SELECT COALESCE(MAX(migration_id),0) FROM effect_sql_migrations").Scan(&n); err != nil {
		return 0, err
	}
	if !supported[n] {
		return 0, fmt.Errorf("unsupported T3 schema migration %d; supported migrations are 40–53", n)
	}
	return n, nil
}

func hashUUID(s string) string {
	h := sha256.Sum256([]byte(s))
	b := h[:16]
	b[6] = (b[6] & 15) | 0x50
	b[8] = (b[8] & 63) | 0x80
	x := hex.EncodeToString(b)
	return x[:8] + "-" + x[8:12] + "-" + x[12:16] + "-" + x[16:20] + "-" + x[20:]
}

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ThreadID and ProjectID mirror the stable ID rules used by the legacy importer.
func ThreadID(thread domain.CanonicalThread) string {
	if thread.Source == domain.SourceCodex && uuidPattern.MatchString(thread.SourceSessionID) {
		return thread.SourceSessionID
	}
	return hashUUID("t3-import:thread:" + thread.SourceKey)
}
func ProjectID(workspace string) string {
	return hashUUID("t3-import:project:" + canonicalPath(workspace))
}
func canonicalPath(value string) string {
	p, err := filepath.Abs(value)
	if err == nil {
		if real, e := filepath.EvalSymlinks(p); e == nil {
			p = real
		}
	}
	p = filepath.Clean(p)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		p = strings.ToLower(p)
	}
	return strings.TrimRight(p, "/\\")
}

func ProjectCreatedEvent(workspace, projectID string, thread domain.CanonicalThread, provider Provider) Event {
	path := canonicalPath(workspace)
	base := filepath.Base(filepath.Clean(workspace))
	return evt("project:"+path, "project.created", "project", projectID, "project.created", thread.CreatedAt, "client", map[string]any{"projectId": projectID, "title": base, "workspaceRoot": workspace, "defaultModelSelection": modelSelection(provider), "scripts": []any{}, "createdAt": thread.CreatedAt, "updatedAt": thread.UpdatedAt}, nil)
}
func modelSelection(provider Provider) map[string]any {
	options := provider.Options
	if options == nil {
		options = []map[string]any{}
	}
	return map[string]any{"instanceId": provider.InstanceID, "model": provider.Model, "options": options}
}
func stable(v any) string { b, _ := json.Marshal(v); return string(b) }
func evt(seed, key, agg, stream, typ, at, actor string, payload, metadata map[string]any) Event {
	if metadata == nil {
		metadata = map[string]any{}
	}
	return Event{Key: key, EventID: hashUUID("t3-import:event:" + seed + ":" + key), AggregateKind: agg, StreamID: stream, Type: typ, OccurredAt: at, ActorKind: actor, Payload: payload, Metadata: metadata}
}

// PlanImport produces the stable legacy event stream. Provider is supplied by
// the caller so configuration resolution remains outside this package.
func PlanImport(thread domain.CanonicalThread, target Target, provider Provider, resumable bool) Plan {
	return planImport(thread, target, provider, resumable, 0, true)
}

func planImport(thread domain.CanonicalThread, target Target, provider Provider, resumable bool, turnOffset int, includeThreadCreated bool) Plan {
	seed := target.IdentitySeed
	if seed == "" {
		seed = thread.SourceKey
	}
	t := target
	selection := modelSelection(provider)
	var events []Event
	if includeThreadCreated {
		events = append(events, evt(seed, "thread.created", "thread", t.ThreadID, "thread.created", thread.CreatedAt, "server", map[string]any{"threadId": t.ThreadID, "projectId": t.ProjectID, "title": thread.Title, "modelSelection": selection, "runtimeMode": "full-access", "interactionMode": "default", "branch": thread.GitBranch, "worktreePath": nil, "createdAt": thread.CreatedAt, "updatedAt": thread.CreatedAt}, nil))
	}
	assetsPlanned := []assets.Asset(nil)
	warnings := append([]string(nil), thread.Warnings...)
	for i, turn := range thread.Turns {
		n := turnOffset + i
		uid := hashUUID("t3-import:message:" + seed + ":" + turn.ID + ":user:" + turn.User.SourceID)
		text, descriptors, planned, attachmentWarnings := assets.PlanMessage(turn.User, t.ThreadID, t.AttachmentsDir)
		assetsPlanned = append(assetsPlanned, planned...)
		warnings = append(warnings, attachmentWarnings...)
		descriptorValues := make([]any, len(descriptors))
		for i, d := range descriptors {
			descriptorValues[i] = d
		}
		events = append(events, evt(seed, fmt.Sprintf("turn.%d.user", n), "thread", t.ThreadID, "thread.message-sent", turn.User.Timestamp, "client", map[string]any{"threadId": t.ThreadID, "messageId": uid, "role": "user", "text": text, "attachments": descriptorValues, "turnId": nil, "streaming": false, "createdAt": turn.User.Timestamp, "updatedAt": turn.User.Timestamp}, nil))
		events = append(events, evt(seed, fmt.Sprintf("turn.%d.start", n), "thread", t.ThreadID, "thread.turn-start-requested", turn.StartedAt, "client", map[string]any{"threadId": t.ThreadID, "messageId": uid, "modelSelection": selection, "titleSeed": truncate(turn.User.Text, 120), "runtimeMode": "full-access", "interactionMode": "default", "createdAt": turn.StartedAt}, nil))
		settled := "interrupted"
		var lastError any
		if turn.Status == domain.TurnCompleted {
			settled = "ready"
		}
		if turn.Status == domain.TurnFailed {
			settled = "error"
			if turn.TerminalError != nil {
				lastError = truncate(*turn.TerminalError, 500)
			} else if turn.TerminalReason != nil {
				lastError = truncate(*turn.TerminalReason, 500)
			} else {
				lastError = "Imported provider turn failed."
			}
		}
		for _, state := range []struct{ key, status, at string }{{"running", "running", turn.StartedAt}, {"settled", settled, settledAt(turn)}} {
			events = append(events, evt(seed, fmt.Sprintf("turn.%d.%s", n, state.key), "thread", t.ThreadID, "thread.session-set", state.at, "provider", map[string]any{"threadId": t.ThreadID, "session": map[string]any{"threadId": t.ThreadID, "status": state.status, "providerName": provider.ProviderName, "providerInstanceId": provider.InstanceID, "runtimeMode": "full-access", "activeTurnId": nil, "lastError": lastError, "updatedAt": state.at}}, map[string]any{"adapterKey": provider.AdapterKey, "providerTurnId": turn.ID}))
		}
		type entry struct {
			at, sourceID, kind string
			message            *domain.CanonicalMessage
			activity           *domain.CanonicalActivity
			plan               *domain.CanonicalPlan
		}
		var timeline []entry
		for i := range turn.Assistant {
			m := turn.Assistant[i]
			timeline = append(timeline, entry{at: m.Timestamp, sourceID: m.SourceID, kind: "message", message: &m})
		}
		for i := range turn.Activities {
			a := turn.Activities[i]
			timeline = append(timeline, entry{at: a.Timestamp, sourceID: a.SourceID, kind: "activity", activity: &a})
		}
		for i := range turn.Plans {
			p := turn.Plans[i]
			timeline = append(timeline, entry{at: p.Timestamp, sourceID: p.SourceID, kind: "plan", plan: &p})
		}
		sort.Slice(timeline, func(i, j int) bool {
			if timeline[i].at == timeline[j].at {
				return timeline[i].sourceID < timeline[j].sourceID
			}
			return timeline[i].at < timeline[j].at
		})
		for j, item := range timeline {
			key := fmt.Sprintf("turn.%d.entry.%d", n, j)
			meta := map[string]any{"adapterKey": provider.AdapterKey, "providerTurnId": turn.ID}
			switch item.kind {
			case "message":
				m := *item.message
				mid := hashUUID("t3-import:message:" + seed + ":" + turn.ID + ":assistant:" + m.SourceID)
				events = append(events, evt(seed, key+".message", "thread", t.ThreadID, "thread.message-sent", m.Timestamp, "provider", map[string]any{"threadId": t.ThreadID, "messageId": mid, "role": "assistant", "text": m.Text, "turnId": turn.ID, "streaming": false, "createdAt": m.Timestamp, "updatedAt": m.Timestamp}, meta))
			case "activity":
				a := *item.activity
				id := hashUUID("t3-import:activity:" + seed + ":" + turn.ID + ":" + a.SourceID)
				summary := a.Summary
				if summary == "" {
					summary = "Activity"
				}
				meta["providerItemId"] = a.SourceID
				events = append(events, evt(seed, key+".activity", "thread", t.ThreadID, "thread.activity-appended", a.Timestamp, "provider", map[string]any{"threadId": t.ThreadID, "activity": map[string]any{"id": id, "tone": a.Tone, "kind": a.Kind, "summary": summary, "payload": a.Payload, "turnId": turn.ID, "sequence": j, "createdAt": a.Timestamp}}, meta))
			case "plan":
				p := *item.plan
				id := hashUUID("t3-import:plan:" + seed + ":" + turn.ID + ":" + p.SourceID)
				meta["providerItemId"] = p.SourceID
				events = append(events, evt(seed, key+".plan", "thread", t.ThreadID, "thread.proposed-plan-upserted", p.Timestamp, "provider", map[string]any{"threadId": t.ThreadID, "proposedPlan": map[string]any{"id": id, "turnId": turn.ID, "planMarkdown": p.Markdown, "implementedAt": nil, "implementationThreadId": nil, "createdAt": p.Timestamp, "updatedAt": p.Timestamp}}, meta))
			}
		}
	}
	if t.CreateProject && includeThreadCreated {
		events = append([]Event{ProjectCreatedEvent(t.Workspace, t.ProjectID, thread, provider)}, events...)
	}
	return Plan{Target: t, Thread: thread, Provider: provider, Events: events, Assets: assetsPlanned, Warnings: warnings, Resumable: resumable}
}

type SyncResult struct {
	Appended                    bool
	TurnsAdded, TurnsAdopted    int
	FirstSequence, LastSequence int64
}

// SyncAppend appends new terminal turns only when the saved checkpoint remains
// an unchanged source prefix. Any T3 event suffix after lastSequence is left
// for the caller to adopt or classify as a conflict.
func SyncAppend(ctx context.Context, db *sql.DB, thread domain.CanonicalThread, target Target, provider Provider, saved checkpoint.CheckpointV2, lastSequence int64, resumable bool) (SyncResult, error) {
	terminalThread := thread
	terminalThread.Turns = make([]domain.CanonicalTurn, 0, len(thread.Turns))
	for _, turn := range thread.Turns {
		if turn.Status.Terminal() {
			terminalThread.Turns = append(terminalThread.Turns, turn)
		}
	}
	current, err := checkpoint.ForThread(terminalThread)
	if err != nil {
		return SyncResult{}, err
	}
	if saved.Version != 2 || len(current.Turns) < len(saved.Turns) {
		return SyncResult{}, errors.New("legacy sync: source history diverged from the saved checkpoint")
	}
	for i, old := range saved.Turns {
		if old.ID != current.Turns[i].ID || old.Hash != current.Turns[i].Hash {
			return SyncResult{}, fmt.Errorf("legacy sync: source history diverged at turn %d", i)
		}
	}
	seed := target.IdentitySeed
	if seed == "" {
		seed = thread.SourceKey
	}
	marker := hashUUID("t3-import:event:" + seed + ":thread.created")
	var found int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM orchestration_events WHERE event_id=? OR (aggregate_kind='thread' AND stream_id=? AND event_type='thread.created')", marker, target.ThreadID).Scan(&found); err != nil {
		return SyncResult{}, err
	}
	if found == 0 {
		return SyncResult{}, errors.New("legacy sync: imported target thread is missing")
	}
	adopted, err := adoptableSuffix(ctx, db, target.ThreadID, terminalThread.Turns[len(saved.Turns):], lastSequence)
	if err != nil {
		return SyncResult{}, err
	}
	newTurns := terminalThread.Turns[len(saved.Turns)+adopted:]
	if len(newTurns) == 0 {
		return SyncResult{Appended: adopted > 0, TurnsAdopted: adopted}, nil
	}
	copyThread := terminalThread
	copyThread.Turns = newTurns
	plan := planImport(copyThread, target, provider, resumable, len(saved.Turns)+adopted, false)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return SyncResult{}, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	first, last, err := appendTx(ctx, tx, plan.Events)
	if err != nil {
		return SyncResult{}, err
	}
	if err = upsertRuntime(ctx, tx, plan, "t3-import.sync."); err != nil {
		return SyncResult{}, err
	}
	err = tx.Commit()
	if err != nil {
		return SyncResult{}, err
	}
	return SyncResult{Appended: true, TurnsAdded: len(newTurns), TurnsAdopted: adopted, FirstSequence: first, LastSequence: last}, nil
}

// adoptableSuffix recognizes only complete provider turns in sequence. Unknown,
// partial, out-of-order, or status-mismatched suffixes fail closed.
func adoptableSuffix(ctx context.Context, db *sql.DB, threadID string, turns []domain.CanonicalTurn, after int64) (int, error) {
	rows, err := db.QueryContext(ctx, `SELECT event_type,payload_json,metadata_json FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? AND sequence>? ORDER BY sequence`, threadID, after)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	settled := map[string]string{}
	seen := map[string]bool{}
	type message struct{ role, text string }
	var messages []message
	suffixCount := 0
	for rows.Next() {
		var typ, p, m string
		if err = rows.Scan(&typ, &p, &m); err != nil {
			return 0, err
		}
		suffixCount++
		var payload, meta map[string]any
		if json.Unmarshal([]byte(p), &payload) != nil || json.Unmarshal([]byte(m), &meta) != nil {
			return 0, errors.New("legacy sync: malformed target event suffix")
		}
		if typ == "thread.message-sent" {
			role, _ := payload["role"].(string)
			text, _ := payload["text"].(string)
			if role == "user" || role == "assistant" {
				messages = append(messages, message{role, text})
			}
		}
		if typ == "thread.session-set" {
			session, _ := payload["session"].(map[string]any)
			id, _ := meta["providerTurnId"].(string)
			status, _ := session["status"].(string)
			if id != "" && (status == "ready" || status == "idle" || status == "interrupted" || status == "stopped" || status == "error") {
				if seen[id] {
					return 0, errors.New("legacy sync: ambiguous duplicate settled provider turn")
				}
				seen[id] = true
				settled[id] = status
			}
		}
	}
	if err = rows.Err(); err != nil {
		return 0, err
	}
	if suffixCount > 0 && len(settled) == 0 {
		return 0, errors.New("legacy sync: target has a partial or unrecognized event suffix")
	}
	count := 0
	for i, t := range turns {
		status, ok := settled[t.ID]
		if !ok {
			break
		}
		expected := map[domain.TurnStatus]string{domain.TurnCompleted: "ready", domain.TurnInterrupted: "interrupted", domain.TurnFailed: "error"}[t.Status]
		if status != expected {
			return 0, errors.New("legacy sync: target provider turn status conflicts with source history")
		}
		count = i + 1
	}
	if len(settled) != count {
		return 0, errors.New("legacy sync: target has an ambiguous or out-of-order provider turn suffix")
	}
	var expectedMessages []message
	for _, turn := range turns[:count] {
		expectedMessages = append(expectedMessages, message{"user", turn.User.Text})
		for _, assistant := range turn.Assistant {
			expectedMessages = append(expectedMessages, message{"assistant", assistant.Text})
		}
	}
	if len(messages) != len(expectedMessages) {
		return 0, errors.New("legacy sync: target provider transcript is partial or ambiguous")
	}
	for i := range messages {
		if messages[i] != expectedMessages[i] {
			return 0, errors.New("legacy sync: target provider transcript conflicts with source history")
		}
	}
	return count, nil
}

func settledAt(t domain.CanonicalTurn) string {
	if t.CompletedAt != nil {
		return *t.CompletedAt
	}
	if len(t.Assistant) > 0 {
		return t.Assistant[len(t.Assistant)-1].Timestamp
	}
	return t.User.Timestamp
}
func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func PreviewImport(ctx context.Context, db *sql.DB, target Target, thread domain.CanonicalThread) (Preview, error) {
	m, err := Migration(ctx, db)
	if err != nil {
		return Preview{}, err
	}
	marker := hashUUID("t3-import:event:" + target.IdentitySeed + ":thread.created")
	var exists int
	err = db.QueryRowContext(ctx, "SELECT COUNT(*) FROM orchestration_events WHERE event_id = ? OR (stream_id = ? AND event_type='thread.created')", marker, target.ThreadID).Scan(&exists)
	if err != nil {
		return Preview{}, err
	}
	return Preview{Exists: true, AlreadyImported: exists > 0, Migration: m, EventCount: len(PlanImport(thread, target, Provider{}, false).Events), Turns: len(thread.Turns)}, nil
}

// BootstrapCheckpoint rebuilds the v2 source cursor only when every imported
// turn's deterministic marker, user text, assistant transcript and settled
// provider-turn identity agree with source history. Partial or ambiguous
// history is rejected.
func BootstrapCheckpoint(ctx context.Context, db *sql.DB, thread domain.CanonicalThread, target Target) (checkpoint.CheckpointV2, int64, error) {
	terminal := thread
	terminal.Turns = nil
	for _, turn := range thread.Turns {
		if turn.Status.Terminal() {
			terminal.Turns = append(terminal.Turns, turn)
		}
	}
	cp, err := checkpoint.ForThread(terminal)
	if err != nil {
		return checkpoint.CheckpointV2{}, 0, err
	}
	seed := target.IdentitySeed
	if seed == "" {
		seed = thread.SourceKey
	}
	rows, err := db.QueryContext(ctx, `SELECT sequence,event_id,event_type,payload_json,metadata_json FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? ORDER BY sequence`, target.ThreadID)
	if err != nil {
		return checkpoint.CheckpointV2{}, 0, err
	}
	defer rows.Close()
	type row struct {
		seq     int64
		id, typ string
		p, m    map[string]any
	}
	var all []row
	for rows.Next() {
		var r row
		var p, m string
		if err = rows.Scan(&r.seq, &r.id, &r.typ, &p, &m); err != nil {
			return checkpoint.CheckpointV2{}, 0, err
		}
		if json.Unmarshal([]byte(p), &r.p) != nil || json.Unmarshal([]byte(m), &r.m) != nil {
			return checkpoint.CheckpointV2{}, 0, errors.New("legacy checkpoint: malformed target event")
		}
		all = append(all, r)
	}
	if err = rows.Err(); err != nil {
		return checkpoint.CheckpointV2{}, 0, err
	}
	if len(all) == 0 {
		return checkpoint.CheckpointV2{}, 0, errors.New("legacy checkpoint: target thread has no events")
	}
	seq := int64(0)
	for i, t := range terminal.Turns {
		keys := []string{fmt.Sprintf("turn.%d.user", i), fmt.Sprintf("turn.%d.start", i), fmt.Sprintf("turn.%d.running", i), fmt.Sprintf("turn.%d.settled", i)}
		var selected [4]*row
		for n, key := range keys {
			want := hashUUID("t3-import:event:" + seed + ":" + key)
			for j := range all {
				if all[j].id == want {
					selected[n] = &all[j]
					break
				}
			}
		}
		for _, r := range selected {
			if r == nil {
				return checkpoint.CheckpointV2{}, 0, errors.New("legacy checkpoint: incomplete imported turn history")
			}
		}
		if selected[0].p["text"] != t.User.Text || selected[2].m["providerTurnId"] != t.ID {
			return checkpoint.CheckpointV2{}, 0, errors.New("legacy checkpoint: imported turn does not match source")
		}
		var status string
		if session, ok := selected[3].p["session"].(map[string]any); ok {
			status, _ = session["status"].(string)
		}
		expected := map[domain.TurnStatus]string{domain.TurnCompleted: "ready", domain.TurnInterrupted: "interrupted", domain.TurnFailed: "error"}[t.Status]
		if status != expected {
			return checkpoint.CheckpointV2{}, 0, errors.New("legacy checkpoint: settled turn status diverged")
		}
		var assistant []string
		for _, r := range all {
			if r.seq > selected[0].seq && r.seq < selected[3].seq && r.typ == "thread.message-sent" && r.p["role"] == "assistant" {
				s, _ := r.p["text"].(string)
				assistant = append(assistant, s)
			}
		}
		want := make([]string, len(t.Assistant))
		for j, m := range t.Assistant {
			want[j] = m.Text
		}
		if stable(assistant) != stable(want) {
			return checkpoint.CheckpointV2{}, 0, errors.New("legacy checkpoint: assistant transcript diverged")
		}
		for _, r := range selected {
			if r.seq > seq {
				seq = r.seq
			}
		}
	}
	return cp, seq, nil
}

// PlanTitleUpdate preserves local edits and proposes a provider title event
// only while the current T3 title still equals the prior source title.
func PlanTitleUpdate(ctx context.Context, db *sql.DB, thread domain.CanonicalThread, target Target, priorSourceTitle string, provider Provider) (Event, bool, error) {
	rows, err := db.QueryContext(ctx, `SELECT event_type,payload_json FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? ORDER BY sequence`, target.ThreadID)
	if err != nil {
		return Event{}, false, err
	}
	defer rows.Close()
	current := ""
	found := false
	for rows.Next() {
		var typ, raw string
		if err = rows.Scan(&typ, &raw); err != nil {
			return Event{}, false, err
		}
		var p map[string]any
		if json.Unmarshal([]byte(raw), &p) != nil {
			return Event{}, false, errors.New("legacy title: malformed target event")
		}
		if typ == "thread.created" || typ == "thread.meta-updated" {
			if title, ok := p["title"].(string); ok && title != "" {
				current = title
				found = true
			}
		}
	}
	if err = rows.Err(); err != nil {
		return Event{}, false, err
	}
	if !found {
		return Event{}, false, errors.New("legacy title: target thread is missing")
	}
	if thread.Title == priorSourceTitle || current != priorSourceTitle {
		return Event{}, false, nil
	}
	seed := target.IdentitySeed
	if seed == "" {
		seed = thread.SourceKey
	}
	return evt(seed, "sync.title."+thread.UpdatedAt, "thread", target.ThreadID, "thread.meta-updated", thread.UpdatedAt, "provider", map[string]any{"threadId": target.ThreadID, "title": thread.Title, "updatedAt": thread.UpdatedAt}, map[string]any{"adapterKey": provider.AdapterKey}), true, nil
}

// Append atomically appends events using the stream's next versions. Duplicate
// event IDs are treated as errors so callers cannot silently claim success.
func Append(ctx context.Context, db *sql.DB, events []Event) (first, last int64, err error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	first, last, err = appendTx(ctx, tx, events)
	if err != nil {
		return
	}
	err = tx.Commit()
	return
}

func appendTx(ctx context.Context, tx *sql.Tx, events []Event) (first, last int64, err error) {
	versions := map[string]int{}
	for _, e := range events {
		key := e.AggregateKind + "\x00" + e.StreamID
		v, ok := versions[key]
		if !ok {
			err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(stream_version),-1)+1 FROM orchestration_events WHERE aggregate_kind=? AND stream_id=?", e.AggregateKind, e.StreamID).Scan(&v)
			if err != nil {
				return
			}
		}
		p, m := stable(e.Payload), stable(e.Metadata)
		var seq int64
		err = tx.QueryRowContext(ctx, `INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json) VALUES(?,?,?,?,?,?,NULL,NULL,NULL,?,?,?) RETURNING sequence`, e.EventID, e.AggregateKind, e.StreamID, v, e.Type, e.OccurredAt, e.ActorKind, p, m).Scan(&seq)
		if err != nil {
			return
		}
		versions[key] = v + 1
		if first == 0 || seq < first {
			first = seq
		}
		if seq > last {
			last = seq
		}
	}
	return
}

// Import appends a planned stream and persists the legacy provider runtime row
// when the plan carries a resumable cursor. Asset materialization remains the
// caller's responsibility so it can roll files back if this transaction fails.
func Import(ctx context.Context, db *sql.DB, plan Plan) (int64, int64, error) {
	if len(plan.Events) == 0 {
		return 0, 0, errors.New("legacy: empty import plan")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	first, last, err := appendTx(ctx, tx, plan.Events)
	if err != nil {
		return 0, 0, err
	}
	if err = upsertRuntime(ctx, tx, plan, "t3-import."); err != nil {
		return 0, 0, err
	}
	err = tx.Commit()
	return first, last, err
}

// SequenceRange identifies the events appended for one plan in ImportBatch.
type SequenceRange struct{ First, Last int64 }

// ImportBatch writes multiple planned thread histories and their runtime rows
// in one transaction. Asset materialization and ledger recording belong to the
// caller and should happen around this database operation.
func ImportBatch(ctx context.Context, db *sql.DB, plans []Plan) ([]SequenceRange, error) {
	if len(plans) == 0 {
		return nil, errors.New("legacy: empty import batch")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	ranges := make([]SequenceRange, 0, len(plans))
	for _, plan := range plans {
		if len(plan.Events) == 0 {
			return nil, errors.New("legacy: empty import plan in batch")
		}
		first, last, e := appendTx(ctx, tx, plan.Events)
		if e != nil {
			return nil, e
		}
		if e = upsertRuntime(ctx, tx, plan, "t3-import."); e != nil {
			return nil, e
		}
		ranges = append(ranges, SequenceRange{First: first, Last: last})
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return ranges, nil
}

func upsertRuntime(ctx context.Context, tx *sql.Tx, plan Plan, eventPrefix string) error {
	if !plan.Resumable || len(plan.Thread.ResumeCursor) == 0 {
		return nil
	}
	cursor := plan.Thread.ResumeCursor
	if plan.Thread.Source == domain.SourceClaude {
		withID := map[string]any{"threadId": plan.Target.ThreadID}
		for k, v := range cursor {
			withID[k] = v
		}
		cursor = withID
	}
	runtimePayload := stable(map[string]any{"cwd": plan.Thread.Workspace, "model": plan.Provider.Model, "activeTurnId": nil, "lastError": nil, "modelSelection": modelSelection(plan.Provider), "lastRuntimeEvent": eventPrefix + string(plan.Thread.Source), "lastRuntimeEventAt": plan.Thread.UpdatedAt})
	_, err := tx.ExecContext(ctx, `INSERT INTO provider_session_runtime(thread_id,provider_name,provider_instance_id,adapter_key,runtime_mode,status,last_seen_at,resume_cursor_json,runtime_payload_json) VALUES(?,?,?,?,'full-access','stopped',?,?,?) ON CONFLICT(thread_id) DO UPDATE SET provider_name=excluded.provider_name,provider_instance_id=excluded.provider_instance_id,adapter_key=excluded.adapter_key,runtime_mode=excluded.runtime_mode,status=excluded.status,last_seen_at=excluded.last_seen_at,resume_cursor_json=excluded.resume_cursor_json,runtime_payload_json=excluded.runtime_payload_json`, plan.Target.ThreadID, plan.Provider.ProviderName, plan.Provider.InstanceID, plan.Provider.AdapterKey, plan.Thread.UpdatedAt, stable(cursor), runtimePayload)
	return err
}

// Sync is a first-import convenience. Existing imports should use SyncAppend
// with their saved checkpoint and last event sequence.
func Sync(ctx context.Context, db *sql.DB, plan Plan) (bool, int64, int64, error) {
	p, err := PreviewImport(ctx, db, plan.Target, plan.Thread)
	if err != nil {
		return false, 0, 0, err
	}
	if p.AlreadyImported {
		return false, 0, 0, nil
	}
	a, b, err := Import(ctx, db, plan)
	return err == nil, a, b, err
}

// Replace appends replacement creation/history plus tombstones in one SQLite
// transaction. It intentionally performs no safety validation: callers must
// verify target identity, old thread existence/deletion state, source inactivity,
// branch constraints, checkpoint divergence, event limits, and runtime transfer.
func Replace(ctx context.Context, db *sql.DB, plan Plan, deletions []Event) (int64, int64, error) {
	if len(plan.Events) == 0 || plan.Target.ThreadID == "" {
		return 0, 0, errors.New("legacy replace: replacement thread history is required")
	}
	if !hasThreadCreated(plan.Events, plan.Target.ThreadID) {
		return 0, 0, errors.New("legacy replace: replacement history lacks thread.created")
	}
	seen := map[string]bool{}
	for _, e := range deletions {
		if e.Type != "thread.deleted" || e.AggregateKind != "thread" || e.StreamID == "" || e.StreamID == plan.Target.ThreadID || seen[e.StreamID] {
			return 0, 0, errors.New("legacy replace: invalid or ambiguous tombstone set")
		}
		seen[e.StreamID] = true
	}
	if len(seen) == 0 {
		return 0, 0, errors.New("legacy replace: no old thread tombstones")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()
	for id := range seen {
		var created, deleted int
		if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? AND event_type='thread.created'", id).Scan(&created); err != nil {
			return 0, 0, err
		}
		if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? AND event_type='thread.deleted'", id).Scan(&deleted); err != nil {
			return 0, 0, err
		}
		if created != 1 || deleted != 0 {
			return 0, 0, fmt.Errorf("legacy replace: old thread %q is missing, ambiguous, or already deleted", id)
		}
	}
	all := append(append([]Event{}, plan.Events...), deletions...)
	first, last, err := appendTx(ctx, tx, all)
	if err != nil {
		return 0, 0, err
	}
	// Transfer at most one runtime binding. Multiple source bindings are ambiguous.
	if len(seen) == 1 {
		var provider, instance, adapter, mode, status, lastSeen string
		var cursor, payload sql.NullString
		var found int
		for id := range seen {
			err = tx.QueryRowContext(ctx, `SELECT provider_name,provider_instance_id,adapter_key,runtime_mode,status,last_seen_at,resume_cursor_json,runtime_payload_json FROM provider_session_runtime WHERE thread_id=?`, id).Scan(&provider, &instance, &adapter, &mode, &status, &lastSeen, &cursor, &payload)
		}
		if err == nil {
			found = 1
		} else if err == sql.ErrNoRows {
			err = nil
		} else {
			return 0, 0, err
		}
		if found == 1 {
			_, err = tx.ExecContext(ctx, `INSERT INTO provider_session_runtime(thread_id,provider_name,provider_instance_id,adapter_key,runtime_mode,status,last_seen_at,resume_cursor_json,runtime_payload_json) VALUES(?,?,?,?,?,'stopped',?,?,?) ON CONFLICT(thread_id) DO UPDATE SET provider_name=excluded.provider_name,provider_instance_id=excluded.provider_instance_id,adapter_key=excluded.adapter_key,runtime_mode=excluded.runtime_mode,status='stopped',last_seen_at=excluded.last_seen_at,resume_cursor_json=excluded.resume_cursor_json,runtime_payload_json=excluded.runtime_payload_json`, plan.Target.ThreadID, provider, instance, adapter, mode, lastSeen, cursor, payload)
			if err != nil {
				return 0, 0, err
			}
			for id := range seen {
				if _, err = tx.ExecContext(ctx, "DELETE FROM provider_session_runtime WHERE thread_id=?", id); err != nil {
					return 0, 0, err
				}
			}
		}
	}
	if err = tx.Commit(); err != nil {
		return 0, 0, err
	}
	return first, last, nil
}

func hasThreadCreated(events []Event, id string) bool {
	for _, e := range events {
		if e.AggregateKind == "thread" && e.StreamID == id && e.Type == "thread.created" {
			return true
		}
	}
	return false
}

// EncodePayload exposes the exact compact JSON encoding used in event rows.
func EncodePayload(v map[string]any) string { return strings.TrimSpace(stable(v)) }
