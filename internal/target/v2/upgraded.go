package v2

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"

	"github.com/runinit/t3-syncaroo/internal/checkpoint"
	"github.com/runinit/t3-syncaroo/internal/domain"
	"github.com/runinit/t3-syncaroo/internal/identity"
)

// UpgradedExpectation binds a converted v1 task to one source ledger mapping.
// A converted task is accepted only when its complete projected transcript is
// exactly the saved source prefix and its provider ownership is unambiguous.
type UpgradedExpectation struct {
	ThreadID, ProjectID, ProviderInstanceID string
	SourceSessionID, IdentitySeed           string
	SourceFingerprint, CurrentFingerprint   string
	Checkpoint                              json.RawMessage
	Resumable                               bool
	NativeThreadID                          string
	NativeConversationHeadID                *string
	AllowNullClaudeHead                     bool
}

// UpgradedMatch carries the proof material required by the app layer to move a
// verified converted task onto the current v2 writer and ledger format.
type UpgradedMatch struct {
	PrefixTurns   int
	Checkpoint    json.RawMessage
	Binding       string
	ProviderEvent *Event
	Projection    *checkpoint.NativeProjectionIdentityV1
	FirstSequence int64
	LastSequence  int64
}

// VerifyUpgradedPrefix verifies a pre-upgrade converted task without writing
// to T3. It rejects extra native history because that history is not covered by
// the saved v1 source checkpoint.
func VerifyUpgradedPrefix(ctx context.Context, db *sql.DB, source domain.CanonicalThread, full Plan, expected UpgradedExpectation, attachmentsDir string) (UpgradedMatch, error) {
	if expected.ThreadID == "" || expected.ProjectID == "" || expected.ProviderInstanceID == "" || expected.SourceSessionID == "" || expected.IdentitySeed == "" {
		return UpgradedMatch{}, errors.New("v2: incomplete upgraded-task identity")
	}
	if source.SourceSessionID != expected.SourceSessionID || full.ThreadID != expected.ThreadID || full.ProjectID != expected.ProjectID || full.ProviderInstanceID != expected.ProviderInstanceID {
		return UpgradedMatch{}, errors.New("v2: upgraded task does not match the saved source, task, project, or provider mapping")
	}
	source.SourceKey = expected.IdentitySeed
	prefixCount, err := upgradedPrefixLength(source, expected)
	if err != nil {
		return UpgradedMatch{}, err
	}
	prefix := source
	prefix.Turns = append([]domain.CanonicalTurn(nil), source.Turns[:prefixCount]...)
	prefixPlan, err := BuildPlanWithRuntimeOptions(prefix, expected.ThreadID, expected.ProjectID, expected.ProviderInstanceID, source.Model, map[string]any{}, false, attachmentsDir, expected.Resumable)
	if err != nil {
		return UpgradedMatch{}, err
	}
	projection, err := InspectBuiltinProjection(ctx, db, expected.ThreadID)
	if err != nil {
		return UpgradedMatch{}, err
	}
	if projection.Thread["id"] != expected.ThreadID || projection.Thread["projectId"] != expected.ProjectID || projection.Thread["providerInstanceId"] != expected.ProviderInstanceID || projection.Thread["historyOrigin"] != "v1_import" {
		return UpgradedMatch{}, errors.New("v2: converted task changed project/provider ownership or import origin")
	}
	if len(projection.ProviderTurns) != 0 {
		return UpgradedMatch{}, errors.New("v2: converted task contains provider-turn history outside its saved source checkpoint")
	}
	expectedMessages, expectedItems, expectedPlans := eventRows(prefixPlan.Events)
	if len(projection.Messages) != len(expectedMessages) || len(projection.TurnItems) != len(expectedItems) || len(projection.Plans) != len(expectedPlans) {
		return UpgradedMatch{}, errors.New("v2: converted task contains extra, missing, or reordered history beyond its saved source prefix")
	}
	if !semanticRowsMatch(projection.Messages, projection.TurnItems, projection.Plans, prefixPlan.Events, false) {
		return UpgradedMatch{}, errors.New("v2: converted task's projected messages, items, or plans differ from the saved source prefix")
	}
	providerEvent := providerThreadEvent(full)
	if providerEvent == nil {
		return UpgradedMatch{}, errors.New("v2: source plan is missing its provider binding")
	}
	var expectedBinding map[string]any
	if err := json.Unmarshal(providerEvent.Payload, &expectedBinding); err != nil {
		return UpgradedMatch{}, err
	}
	activeID, _ := projection.Thread["activeProviderThreadId"].(string)
	if len(projection.Events) == 0 {
		return UpgradedMatch{}, errors.New("v2: converted task has no v2 event sequence to anchor its mapping")
	}
	if identity.CanonicalPath(source.Workspace) != identity.CanonicalPath(projection.WorkspaceRoot) {
		return UpgradedMatch{}, errors.New("v2: converted task belongs to a different source workspace")
	}
	match := UpgradedMatch{PrefixTurns: prefixCount, Binding: "exact", FirstSequence: projection.Events[0].Sequence, LastSequence: projection.Events[len(projection.Events)-1].Sequence}
	if activeID == "" && len(projection.ProviderThreads) == 0 {
		match.Binding = "absent"
		match.ProviderEvent = providerEvent
	} else {
		if activeID == "" || len(projection.ProviderThreads) != 1 {
			return UpgradedMatch{}, errors.New("v2: converted task has a missing, extra, or ambiguous provider binding")
		}
		binding := projection.ProviderThreads[0]
		if binding["id"] != activeID || binding["appThreadId"] != expected.ThreadID || binding["driver"] != expectedBinding["driver"] || binding["providerInstanceId"] != expected.ProviderInstanceID {
			return UpgradedMatch{}, errors.New("v2: converted task's active binding belongs to a different provider or task")
		}
		expectedNativeRef := expectedBinding["nativeThreadRef"]
		if expected.Resumable {
			ref, ok := expectedNativeRef.(map[string]any)
			if !ok || ref["strength"] != "strong" || ref["nativeId"] != expected.NativeThreadID || ref["driver"] != expectedBinding["driver"] {
				return UpgradedMatch{}, errors.New("v2: source plan does not carry the saved strong source-session identity")
			}
		} else if expectedNativeRef != nil {
			return UpgradedMatch{}, errors.New("v2: source plan violates the saved resume opt-out")
		}
		if !reflect.DeepEqual(binding["nativeThreadRef"], expectedNativeRef) {
			return UpgradedMatch{}, errors.New("v2: converted task's active binding does not identify the saved source session")
		}
		if source.Source == domain.SourceClaude && expected.Resumable {
			head, _ := binding["nativeConversationHeadRef"].(map[string]any)
			if expected.AllowNullClaudeHead && binding["nativeConversationHeadRef"] == nil {
				match.Binding = "needs-head"
				match.ProviderEvent, err = headAttachmentEvent(providerEvent, binding, source, expected)
				if err != nil {
					return UpgradedMatch{}, err
				}
			} else if expected.NativeConversationHeadID == nil || head == nil || head["driver"] != "claudeAgent" || head["strength"] != "strong" || head["nativeId"] != *expected.NativeConversationHeadID {
				return UpgradedMatch{}, errors.New("v2: converted Claude binding head differs from its saved source head")
			}
		} else if binding["nativeConversationHeadRef"] != nil {
			return UpgradedMatch{}, errors.New("v2: converted provider binding has an unexpected conversation head")
		}
	}

	match.Projection, err = CaptureBuiltinProjectionIdentity(projection)
	if err != nil {
		return UpgradedMatch{}, err
	}
	checkpointValue, err := checkpoint.ForThread(prefix)
	if err != nil {
		return UpgradedMatch{}, err
	}
	checkpointValue.NativeProjection = match.Projection
	match.Checkpoint, err = json.Marshal(checkpointValue)
	if err != nil {
		return UpgradedMatch{}, err
	}
	return match, nil
}

func upgradedPrefixLength(thread domain.CanonicalThread, expected UpgradedExpectation) (int, error) {
	if len(expected.Checkpoint) == 0 {
		if expected.CurrentFingerprint != expected.SourceFingerprint || len(thread.Turns) == 0 {
			return 0, errors.New("v2: converted task has no checkpoint and its saved source fingerprint no longer matches the full source")
		}
		return len(thread.Turns), nil
	}
	saved, valid := checkpoint.Parse(string(expected.Checkpoint))
	count := upgradedCheckpointTurnCount(saved)
	if !valid || count == 0 || count > len(thread.Turns) {
		return 0, errors.New("v2: converted task has an invalid or non-prefix source checkpoint")
	}
	current, err := checkpoint.ForThread(thread)
	if err != nil {
		return 0, err
	}
	for index := 0; index < count; index++ {
		turn := thread.Turns[index]
		switch saved.Version {
		case 1:
			hash, err := checkpoint.LegacyTurnSemanticHash(turn)
			if err != nil || saved.V1.Turns[index].ID != turn.ID || saved.V1.Turns[index].Hash != hash || turn.Status != domain.TurnCompleted {
				return 0, errors.New("v2: source no longer matches its saved converted-task checkpoint")
			}
		case 2:
			expectedTurn := saved.V2.Turns[index]
			currentTurn := current.Turns[index]
			if expectedTurn.ID != currentTurn.ID || expectedTurn.Hash != currentTurn.Hash || expectedTurn.Status != currentTurn.Status || valueString(expectedTurn.TerminalReason) != valueString(currentTurn.TerminalReason) || valueString(expectedTurn.TerminalError) != valueString(currentTurn.TerminalError) {
				return 0, errors.New("v2: source no longer matches its saved converted-task checkpoint")
			}
		default:
			return 0, fmt.Errorf("v2: unsupported converted-task checkpoint version %d", saved.Version)
		}
	}
	return count, nil
}

func upgradedCheckpointTurnCount(saved checkpoint.Stored) int {
	if saved.Version == 1 && saved.V1 != nil {
		return len(saved.V1.Turns)
	}
	if saved.Version == 2 && saved.V2 != nil {
		return len(saved.V2.Turns)
	}
	return 0
}

func providerThreadEvent(plan Plan) *Event {
	for index := range plan.Events {
		if plan.Events[index].Type == "provider-thread.updated" {
			return &plan.Events[index]
		}
	}
	return nil
}

func headAttachmentEvent(event *Event, binding map[string]any, thread domain.CanonicalThread, expected UpgradedExpectation) (*Event, error) {
	currentHead, _ := thread.ResumeCursor["resumeSessionAt"].(string)
	if currentHead == "" {
		return nil, errors.New("v2: Claude source has no current conversation head")
	}
	var payload map[string]any
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return nil, err
	}
	for key, value := range binding {
		payload[key] = value
	}
	payload["nativeConversationHeadRef"] = map[string]any{"driver": "claudeAgent", "nativeId": currentHead, "strength": "strong"}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	copyEvent := *event
	copyEvent.ID = BuiltinHeadEventID(expected.ProviderInstanceID, expected.SourceSessionID, expected.IdentitySeed, currentHead)
	copyEvent.Payload = encoded
	return &copyEvent, nil
}
