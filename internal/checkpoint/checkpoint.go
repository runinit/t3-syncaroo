// Package checkpoint computes and validates the importer's durable source
// history cursors. Its hashes must remain compatible with the TypeScript v1
// and v2 checkpoint formats while old ledgers are being read.
package checkpoint

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/runinit/t3-syncaroo/internal/domain"
)

type TurnV1 struct {
	ID   string `json:"id"`
	Hash string `json:"hash"`
}

type CheckpointV1 struct {
	Version int      `json:"version"`
	Turns   []TurnV1 `json:"turns"`
}

type TurnV2 struct {
	ID             string            `json:"id"`
	Status         domain.TurnStatus `json:"status"`
	TerminalReason *string           `json:"terminalReason,omitempty"`
	TerminalError  *string           `json:"terminalError,omitempty"`
	Hash           string            `json:"hash"`
}

type TurnItemBinding struct {
	ProviderThreadID *string `json:"providerThreadId"`
	ProviderTurnID   *string `json:"providerTurnId"`
	NativeItemRef    any     `json:"nativeItemRef"`
}

type NativeProjectionIdentityV1 struct {
	Kind             string            `json:"kind"`
	Messages         []string          `json:"messages"`
	TurnItems        []string          `json:"turnItems"`
	Plans            []string          `json:"plans"`
	ProviderTurns    *[]string         `json:"providerTurns,omitempty"`
	TurnItemBindings []TurnItemBinding `json:"turnItemBindings,omitempty"`
}

type CheckpointV2 struct {
	Version          int                         `json:"version"`
	Turns            []TurnV2                    `json:"turns"`
	NativeProjection *NativeProjectionIdentityV1 `json:"nativeProjection,omitempty"`
}

// Stored is the union of checkpoint versions accepted from the external
// ledger. V1 remains readable; all new checkpoints are V2.
type Stored struct {
	Version int
	V1      *CheckpointV1
	V2      *CheckpointV2
}

func LegacyTurnSemanticHash(turn domain.CanonicalTurn) (string, error) {
	payload := turnPayload(turn)
	payload["complete"] = true
	return hashCanonical(payload)
}

func TurnSemanticHash(turn domain.CanonicalTurn) (string, error) {
	payload := turnPayload(turn)
	payload["status"] = turn.Status
	payload["terminalReason"] = valueOrNil(turn.TerminalReason)
	payload["terminalError"] = valueOrNil(turn.TerminalError)
	return hashCanonical(payload)
}

func ForThread(thread domain.CanonicalThread) (CheckpointV2, error) {
	checkpoint := CheckpointV2{Version: 2, Turns: make([]TurnV2, 0, len(thread.Turns))}
	for _, turn := range thread.Turns {
		if !turn.Status.Terminal() {
			continue
		}
		hash, err := TurnSemanticHash(turn)
		if err != nil {
			return CheckpointV2{}, fmt.Errorf("checkpoint turn %q: %w", turn.ID, err)
		}
		checkpoint.Turns = append(checkpoint.Turns, TurnV2{
			ID: turn.ID, Status: turn.Status,
			TerminalReason: nonEmpty(turn.TerminalReason),
			TerminalError:  nonEmpty(turn.TerminalError), Hash: hash,
		})
	}
	return checkpoint, nil
}

func Parse(raw string) (Stored, bool) {
	var header struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal([]byte(raw), &header); err != nil {
		return Stored{}, false
	}
	switch header.Version {
	case 1:
		var value CheckpointV1
		if err := json.Unmarshal([]byte(raw), &value); err != nil || !validTurnsV1(value.Turns) {
			return Stored{}, false
		}
		return Stored{Version: 1, V1: &value}, true
	case 2:
		var value CheckpointV2
		if err := json.Unmarshal([]byte(raw), &value); err != nil || !validTurnsV2(value.Turns) || !validProjection(value.NativeProjection) {
			return Stored{}, false
		}
		return Stored{Version: 2, V2: &value}, true
	default:
		return Stored{}, false
	}
}

func turnPayload(turn domain.CanonicalTurn) map[string]any {
	attachments := make([]any, 0, len(turn.User.Attachments))
	for _, attachment := range turn.User.Attachments {
		var contentHash any
		if attachment.Data != nil {
			contentHash = hashBytes(attachment.Data.Data)
		}
		attachments = append(attachments, map[string]any{
			"sourceId": attachment.SourceID, "name": attachment.Name,
			"mimeType": attachment.MIMEType, "sizeBytes": attachment.SizeBytes,
			"remoteUrl": valueOrNil(attachment.RemoteURL), "contentHash": contentHash,
		})
	}
	assistant := make([]any, 0, len(turn.Assistant))
	for _, message := range turn.Assistant {
		assistant = append(assistant, map[string]any{"sourceId": message.SourceID, "text": message.Text, "timestamp": message.Timestamp})
	}
	activities := make([]any, 0, len(turn.Activities))
	for _, activity := range turn.Activities {
		activities = append(activities, map[string]any{
			"sourceId": activity.SourceID, "kind": activity.Kind, "tone": activity.Tone,
			"summary": activity.Summary, "timestamp": activity.Timestamp, "payload": activity.Payload,
		})
	}
	plans := make([]any, 0, len(turn.Plans))
	for _, plan := range turn.Plans {
		plans = append(plans, map[string]any{"sourceId": plan.SourceID, "markdown": plan.Markdown, "timestamp": plan.Timestamp})
	}
	return map[string]any{
		"id": turn.ID, "startedAt": turn.StartedAt, "completedAt": valueOrNil(turn.CompletedAt),
		"user": map[string]any{
			"sourceId": turn.User.SourceID, "text": turn.User.Text, "timestamp": turn.User.Timestamp,
			"attachments": attachments,
		},
		"assistant": assistant, "activities": activities, "plans": plans,
	}
}

func hashCanonical(value any) (string, error) {
	data, err := canonicalJSON(value)
	if err != nil {
		return "", err
	}
	return hashBytes(data), nil
}

func canonicalJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'}), nil
}

func hashBytes(value []byte) string {
	hash := sha256.Sum256(value)
	return hex.EncodeToString(hash[:])
}

func valueOrNil(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nonEmpty(value *string) *string {
	if value == nil || *value == "" {
		return nil
	}
	return value
}

func validTurnsV1(turns []TurnV1) bool {
	for _, turn := range turns {
		if turn.ID == "" || turn.Hash == "" {
			return false
		}
	}
	return true
}

func validTurnsV2(turns []TurnV2) bool {
	for _, turn := range turns {
		if turn.ID == "" || turn.Hash == "" || !turn.Status.Terminal() {
			return false
		}
	}
	return true
}

func validProjection(value *NativeProjectionIdentityV1) bool {
	if value == nil {
		return true
	}
	if value.Kind != "semantic-native-prefix-v1" || len(value.Messages) == 0 || len(value.TurnItems) == 0 {
		return false
	}
	valuesToCheck := [][]string{value.Messages, value.TurnItems, value.Plans}
	if value.ProviderTurns != nil {
		valuesToCheck = append(valuesToCheck, *value.ProviderTurns)
	}
	for _, values := range valuesToCheck {
		seen := map[string]bool{}
		for _, item := range values {
			if item == "" || seen[item] {
				return false
			}
			seen[item] = true
		}
	}
	if len(value.TurnItemBindings) > 0 && len(value.TurnItemBindings) != len(value.TurnItems) {
		return false
	}
	return true
}
