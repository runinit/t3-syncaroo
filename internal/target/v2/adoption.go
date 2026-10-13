package v2

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"strings"

	"github.com/CarlosGtrz/t3-import/internal/checkpoint"
	"github.com/CarlosGtrz/t3-import/internal/domain"
	"github.com/CarlosGtrz/t3-import/internal/identity"
)

// BuiltinProjection is the complete read model needed to verify a task made by
// T3's own provider import. Matching is read-only; callers persist ownership
// only after every identity and history check succeeds.
type BuiltinProjection struct {
	Thread           map[string]any
	WorkspaceRoot    string
	Messages         []map[string]any
	TurnItems        []map[string]any
	Plans            []map[string]any
	ProviderThreads  []map[string]any
	ProviderTurns    []map[string]any
	Runs             []map[string]any
	RunAttempts      []map[string]any
	Nodes            []map[string]any
	Checkpoints      []map[string]any
	CheckpointScopes []map[string]any
	ContextHandoffs  []map[string]any
	Events           []StoredEvent
}

type BuiltinMatch struct {
	ThreadID         string
	ProviderThreadID string
	HeadEvent        *Event
	FirstSequence    int64
	LastSequence     int64
	NativeProjection *checkpoint.NativeProjectionIdentityV1
}

// InspectBuiltinProjection reads the native projections and event stream for
// a candidate built-in import without changing the target.
func InspectBuiltinProjection(ctx context.Context, db *sql.DB, threadID string) (BuiltinProjection, error) {
	if db == nil || threadID == "" {
		return BuiltinProjection{}, errors.New("v2: database and built-in thread ID are required")
	}
	var out BuiltinProjection
	var payload string
	err := db.QueryRowContext(ctx, `SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=? AND deleted_at IS NULL`, threadID).Scan(&payload)
	if err != nil {
		return out, err
	}
	if err = json.Unmarshal([]byte(payload), &out.Thread); err != nil {
		return out, err
	}
	projectID, _ := out.Thread["projectId"].(string)
	if projectID == "" {
		return BuiltinProjection{}, errors.New("v2: built-in thread has no project identity")
	}
	if err = db.QueryRowContext(ctx, `SELECT workspace_root FROM projection_projects WHERE project_id=? AND deleted_at IS NULL`, projectID).Scan(&out.WorkspaceRoot); err != nil {
		return out, err
	}
	if out.Messages, err = readPayloadRows(ctx, db, `SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=? ORDER BY rowid`, threadID); err != nil {
		return out, err
	}
	if out.TurnItems, err = readPayloadRows(ctx, db, `SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=? ORDER BY ordinal,rowid`, threadID); err != nil {
		return out, err
	}
	if out.Plans, err = readPayloadRows(ctx, db, `SELECT payload_json FROM orchestration_v2_projection_plans WHERE thread_id=? ORDER BY rowid`, threadID); err != nil {
		return out, err
	}
	for _, recovery := range []struct {
		table string
		dest  *[]map[string]any
	}{
		{"orchestration_v2_projection_runs", &out.Runs},
		{"orchestration_v2_projection_run_attempts", &out.RunAttempts},
		{"orchestration_v2_projection_nodes", &out.Nodes},
		{"orchestration_v2_projection_checkpoints", &out.Checkpoints},
		{"orchestration_v2_projection_checkpoint_scopes", &out.CheckpointScopes},
		{"orchestration_v2_projection_context_handoffs", &out.ContextHandoffs},
	} {
		if *recovery.dest, err = readOptionalPayloadRows(ctx, db, recovery.table, threadID); err != nil {
			return out, err
		}
	}
	if out.ProviderThreads, err = readPayloadRows(ctx, db, `SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id=? ORDER BY rowid`, threadID); err != nil {
		return out, err
	}
	out.Events, err = Read(ctx, db, threadID)
	if err == nil {
		for _, row := range out.Events {
			if row.Event.Type != "provider-turn.updated" {
				continue
			}
			var turn map[string]any
			if json.Unmarshal(row.Event.Payload, &turn) != nil {
				return BuiltinProjection{}, errors.New("v2: malformed provider-turn event")
			}
			out.ProviderTurns = append(out.ProviderTurns, turn)
		}
	}
	return out, err
}

func readOptionalPayloadRows(ctx context.Context, db *sql.DB, table, threadID string) ([]map[string]any, error) {
	var exists int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&exists); err != nil {
		return nil, err
	}
	if exists == 0 {
		return nil, nil
	}
	return readPayloadRows(ctx, db, `SELECT payload_json FROM `+table+` WHERE thread_id=?`, threadID)
}

// CaptureBuiltinProjectionIdentity stores the concrete ordered row identities
// that were verified when a built-in import was adopted. Later syncs use this
// as the immutable prefix anchor while accepting only separately proven native
// continuations.
func CaptureBuiltinProjectionIdentity(projection BuiltinProjection) (*checkpoint.NativeProjectionIdentityV1, error) {
	providerTurns := make([]string, 0, len(projection.ProviderTurns))
	identity := &checkpoint.NativeProjectionIdentityV1{Kind: "semantic-native-prefix-v1", ProviderTurns: &providerTurns}
	for _, row := range projection.Messages {
		id, _ := row["id"].(string)
		if id == "" {
			return nil, errors.New("v2: built-in projection contains a message without an ID")
		}
		identity.Messages = append(identity.Messages, id)
	}
	for _, row := range projection.TurnItems {
		id, _ := row["id"].(string)
		if id == "" {
			return nil, errors.New("v2: built-in projection contains a turn item without an ID")
		}
		identity.TurnItems = append(identity.TurnItems, id)
		binding := checkpoint.TurnItemBinding{ProviderThreadID: nullableStringPointer(row["providerThreadId"]), ProviderTurnID: nullableStringPointer(row["providerTurnId"]), NativeItemRef: row["nativeItemRef"]}
		identity.TurnItemBindings = append(identity.TurnItemBindings, binding)
	}
	for _, row := range projection.Plans {
		id, _ := row["id"].(string)
		if id == "" {
			return nil, errors.New("v2: built-in projection contains a plan without an ID")
		}
		identity.Plans = append(identity.Plans, id)
	}
	for _, row := range projection.ProviderTurns {
		id, _ := row["id"].(string)
		if id == "" {
			return nil, errors.New("v2: built-in projection contains a provider turn without an ID")
		}
		*identity.ProviderTurns = append(*identity.ProviderTurns, id)
	}
	if len(identity.Messages) == 0 || len(identity.TurnItems) == 0 {
		return nil, errors.New("v2: built-in projection has no complete transcript history")
	}
	return identity, nil
}

func nullableStringPointer(value any) *string {
	text, ok := value.(string)
	if !ok || text == "" {
		return nil
	}
	return &text
}

func readPayloadRows(ctx context.Context, db *sql.DB, query, threadID string) ([]map[string]any, error) {
	rows, err := db.QueryContext(ctx, query, threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []map[string]any
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		var item map[string]any
		if err = json.Unmarshal([]byte(raw), &item); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// MatchBuiltinImport proves that a built-in T3 import is the exact text-only
// representation of the selected source thread. The returned head event is
// present only when a verified Claude import needs its source conversation head
// attached. Codex tasks need no additional write.
func MatchBuiltinImport(ctx context.Context, db *sql.DB, thread domain.CanonicalThread, sourceCandidates []domain.CanonicalThread, providerInstanceID, projectID, attachmentsDir string) (BuiltinMatch, error) {
	threadID := "import:" + providerInstanceID + ":" + thread.SourceSessionID
	projection, err := InspectBuiltinProjection(ctx, db, threadID)
	if err != nil {
		return BuiltinMatch{}, err
	}
	driver := driverFor(thread)
	if projection.Thread["id"] != threadID || projection.Thread["projectId"] != projectID || projection.Thread["historyOrigin"] != "v1_import" || projection.Thread["providerInstanceId"] != providerInstanceID {
		return BuiltinMatch{}, errors.New("v2: built-in task identity or ownership does not match this source")
	}
	if identity.CanonicalPath(thread.Workspace) != identity.CanonicalPath(projection.WorkspaceRoot) {
		return BuiltinMatch{}, errors.New("v2: built-in task belongs to a different source workspace")
	}
	activeID, _ := projection.Thread["activeProviderThreadId"].(string)
	if activeID == "" || len(projection.ProviderThreads) != 1 {
		return BuiltinMatch{}, errors.New("v2: built-in task has a missing or ambiguous active provider binding")
	}
	binding := projection.ProviderThreads[0]
	nativeRef, _ := binding["nativeThreadRef"].(map[string]any)
	expectedNativeID := thread.SourceSessionID
	if thread.Source == domain.SourceCodex {
		if value, ok := thread.ResumeCursor["threadId"].(string); ok && value != "" {
			expectedNativeID = value
		}
	}
	if binding["id"] != activeID || binding["appThreadId"] != threadID || binding["driver"] != driver || binding["providerInstanceId"] != providerInstanceID || nativeRef["driver"] != driver || nativeRef["strength"] != "strong" || nativeRef["nativeId"] != expectedNativeID {
		return BuiltinMatch{}, errors.New("v2: built-in provider binding does not identify the exact strong source session")
	}
	if thread.Source == domain.SourceClaude {
		if !thread.CurrentBranch || thread.LeafID == nil || countSessionCandidates(sourceCandidates, thread.SourceSessionID) != 1 {
			return BuiltinMatch{}, errors.New("v2: Claude source branch identity is ambiguous")
		}
		head, _ := thread.ResumeCursor["resumeSessionAt"].(string)
		lastAssistant := ""
		if len(thread.Turns) > 0 && len(thread.Turns[len(thread.Turns)-1].Assistant) > 0 {
			lastAssistant = thread.Turns[len(thread.Turns)-1].Assistant[len(thread.Turns[len(thread.Turns)-1].Assistant)-1].SourceID
		}
		if head == "" || claudeAssistantNodeID(lastAssistant) != head {
			return BuiltinMatch{}, errors.New("v2: Claude source head does not match the selected assistant lineage")
		}
	} else if thread.Source != domain.SourceCodex {
		return BuiltinMatch{}, errors.New("v2: unsupported source for built-in import adoption")
	} else if binding["nativeConversationHeadRef"] != nil {
		return BuiltinMatch{}, errors.New("v2: built-in Codex task has an unexpected conversation head")
	}
	if !builtinTextOnly(thread) {
		return BuiltinMatch{}, errors.New("v2: source contains history omitted by T3's text-only built-in import")
	}
	plan, err := BuildPlanWithRuntimeOptions(thread, threadID, projectID, providerInstanceID, thread.Model, map[string]any{}, false, attachmentsDir, len(thread.ResumeCursor) > 0)
	if err != nil {
		return BuiltinMatch{}, err
	}
	if !semanticBuiltinHistoryMatches(projection, plan.Events) {
		return BuiltinMatch{}, errors.New("v2: built-in task history differs from the complete source transcript")
	}
	messageItems := filterTypes(projection.TurnItems, "user_message", "assistant_message")
	if len(messageItems) != len(projection.Messages) {
		return BuiltinMatch{}, errors.New("v2: built-in turn items do not correspond to every projected message")
	}
	sourceMessages := canonicalMessages(thread)
	for index, item := range messageItems {
		if item["messageId"] != projection.Messages[index]["id"] || item["text"] != projection.Messages[index]["text"] {
			return BuiltinMatch{}, errors.New("v2: built-in turn item references a different message")
		}
		ref, _ := item["nativeItemRef"].(map[string]any)
		if ref == nil {
			continue
		}
		want := sourceMessages[index].SourceID
		if thread.Source == domain.SourceClaude && sourceMessages[index].Role == "assistant" {
			want = claudeAssistantNodeID(want)
		}
		if ref["driver"] != driver || ref["strength"] != "strong" || ref["nativeId"] != want {
			return BuiltinMatch{}, errors.New("v2: built-in turn item references a different native source item")
		}
	}
	if len(projection.ProviderTurns) != 0 || hasProviderTurn(projection.Events) {
		return BuiltinMatch{}, errors.New("v2: built-in task already contains native provider turns")
	}
	result := BuiltinMatch{ThreadID: threadID, ProviderThreadID: activeID}
	result.NativeProjection, err = CaptureBuiltinProjectionIdentity(projection)
	if err != nil {
		return BuiltinMatch{}, err
	}
	if len(projection.Events) > 0 {
		result.FirstSequence = projection.Events[0].Sequence
		result.LastSequence = projection.Events[len(projection.Events)-1].Sequence
	}
	if thread.Source == domain.SourceClaude {
		headID := thread.ResumeCursor["resumeSessionAt"].(string)
		headRef, _ := binding["nativeConversationHeadRef"].(map[string]any)
		eventID := identity.UUID("t3-import:adopt-built-in-head:" + providerInstanceID + ":" + thread.SourceSessionID + ":" + thread.SourceKey + ":" + headID)
		var owned *StoredEvent
		for i := range projection.Events {
			if projection.Events[i].Event.ID == eventID {
				owned = &projection.Events[i]
				break
			}
		}
		payload := cloneMap(binding)
		payload["nativeConversationHeadRef"] = map[string]any{"driver": driver, "nativeId": headID, "strength": "strong"}
		payload["updatedAt"] = thread.UpdatedAt
		alreadyAttached := headRef["driver"] == driver && headRef["nativeId"] == headID && headRef["strength"] == "strong" && owned != nil && owned.Event.Type == "provider-thread.updated" && owned.Event.ThreadID == threadID && owned.Event.OccurredAt == thread.UpdatedAt
		if alreadyAttached {
			var actual map[string]any
			if json.Unmarshal(owned.Event.Payload, &actual) != nil || !reflect.DeepEqual(actual, payload) {
				alreadyAttached = false
			}
		}
		if owned != nil && !alreadyAttached {
			return BuiltinMatch{}, errors.New("v2: Claude head attachment event ID is already used by a different event")
		}
		if headRef != nil && !alreadyAttached {
			return BuiltinMatch{}, errors.New("v2: built-in Claude task has an unowned conversation head")
		}
		if !alreadyAttached {
			encoded, _ := json.Marshal(payload)
			result.HeadEvent = &Event{ID: eventID, Type: "provider-thread.updated", ThreadID: threadID, Driver: driver, ProviderInstanceID: providerInstanceID, OccurredAt: thread.UpdatedAt, Payload: encoded}
		}
	}
	return result, nil
}

func semanticBuiltinHistoryMatches(target BuiltinProjection, events []Event) bool {
	var messages, items, plans []map[string]any
	for _, event := range events {
		var payload map[string]any
		if json.Unmarshal(event.Payload, &payload) != nil {
			return false
		}
		switch event.Type {
		case "message.updated":
			messages = append(messages, payload)
		case "turn-item.updated":
			items = append(items, payload)
		case "plan.updated":
			plans = append(plans, payload)
		}
	}
	if len(target.Messages) != len(messages) || len(target.TurnItems) != len(items) || len(target.Plans) != len(plans) {
		return false
	}
	for index, expected := range messages {
		if !semanticMapEqual(target.Messages[index], expected, "id", "threadId") {
			return false
		}
	}
	for index, expected := range items {
		if !semanticMapEqual(target.TurnItems[index], expected, "id", "threadId", "messageId", "ordinal") {
			return false
		}
	}
	for index, expected := range plans {
		if !semanticMapEqual(target.Plans[index], expected, "id", "threadId", "nodeId") {
			return false
		}
	}
	return true
}

func semanticMapEqual(actual, expected map[string]any, ignored ...string) bool {
	ignore := make(map[string]bool, len(ignored))
	for _, key := range ignored {
		ignore[key] = true
	}
	for key, value := range expected {
		if !ignore[key] && !reflect.DeepEqual(actual[key], value) {
			return false
		}
	}
	return true
}

func builtinTextOnly(thread domain.CanonicalThread) bool {
	if len(thread.Turns) == 0 || thread.IgnoredInProgressTurns != nil && *thread.IgnoredInProgressTurns > 0 {
		return false
	}
	for _, turn := range thread.Turns {
		if turn.Status != domain.TurnCompleted || len(turn.Activities) > 0 || len(turn.Plans) > 0 || len(turn.User.Attachments) > 0 {
			return false
		}
		for _, message := range turn.Assistant {
			if len(message.Attachments) > 0 {
				return false
			}
		}
	}
	return true
}

func countSessionCandidates(candidates []domain.CanonicalThread, sessionID string) int {
	count := 0
	for _, candidate := range candidates {
		if candidate.SourceSessionID == sessionID {
			count++
		}
	}
	return count
}

func claudeAssistantNodeID(sourceID string) string {
	index := strings.LastIndex(sourceID, ":text:")
	if index <= 0 {
		return ""
	}
	if _, err := strconv.Atoi(sourceID[index+len(":text:"):]); err != nil {
		return ""
	}
	return sourceID[:index]
}

func canonicalMessages(thread domain.CanonicalThread) []domain.CanonicalMessage {
	var messages []domain.CanonicalMessage
	for _, turn := range thread.Turns {
		messages = append(messages, turn.User)
		messages = append(messages, turn.Assistant...)
	}
	return messages
}

func filterTypes(values []map[string]any, types ...string) []map[string]any {
	allowed := make(map[string]bool, len(types))
	for _, value := range types {
		allowed[value] = true
	}
	var result []map[string]any
	for _, value := range values {
		if kind, _ := value["type"].(string); allowed[kind] {
			result = append(result, value)
		}
	}
	return result
}

func hasProviderTurn(events []StoredEvent) bool {
	for _, event := range events {
		if strings.HasPrefix(event.Event.Type, "provider-turn.") {
			return true
		}
	}
	return false
}

func cloneMap(source map[string]any) map[string]any {
	clone := make(map[string]any, len(source))
	for key, value := range source {
		clone[key] = value
	}
	return clone
}

func BuiltinHeadEventID(providerInstanceID, sourceSessionID, sourceKey, headID string) string {
	return identity.UUID("t3-import:adopt-built-in-head:" + providerInstanceID + ":" + sourceSessionID + ":" + sourceKey + ":" + headID)
}
