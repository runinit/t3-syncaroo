package v2

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/runinit/t3-syncaroo/internal/checkpoint"
	"github.com/runinit/t3-syncaroo/internal/domain"
)

func TestVerifyUpgradedPrefixReturnsNativeBindingForExactConvertedHistory(t *testing.T) {
	db := fixture(t)
	thread := builtinAdoptionThread(domain.SourceCodex)
	thread.ResumeCursor = map[string]any{"threadId": "native-session"}
	threadID := "native-session"
	full, err := BuildPlanWithRuntimeOptions(thread, threadID, "p-1", "codex", thread.Model, map[string]any{}, false, "", true)
	if err != nil {
		t.Fatal(err)
	}
	converted := full
	converted.Runtime = nil
	converted.Events = nil
	for _, event := range full.Events {
		if event.Type == "provider-thread.updated" {
			continue
		}
		if event.Type == "thread.created" {
			var payload map[string]any
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				t.Fatal(err)
			}
			payload["activeProviderThreadId"] = nil
			event.Payload, _ = json.Marshal(payload)
		}
		converted.Events = append(converted.Events, event)
	}
	if _, err = AppendPlan(context.Background(), db, converted); err != nil {
		t.Fatal(err)
	}
	saved, err := checkpoint.ForThread(thread)
	if err != nil {
		t.Fatal(err)
	}
	checkpointJSON, _ := json.Marshal(saved)
	match, err := VerifyUpgradedPrefix(context.Background(), db, thread, full, UpgradedExpectation{
		ThreadID: threadID, ProjectID: "p-1", ProviderInstanceID: "codex", SourceSessionID: thread.SourceSessionID,
		IdentitySeed: thread.SourceKey, SourceFingerprint: "same", CurrentFingerprint: "same", Checkpoint: checkpointJSON,
		Resumable: true, NativeThreadID: "native-session",
	}, "")
	if err != nil {
		t.Fatalf("verify exact converted history: %v", err)
	}
	if match.PrefixTurns != 1 || match.Binding != "absent" || match.ProviderEvent == nil || match.Projection == nil {
		t.Fatalf("unexpected converted task proof: %+v", match)
	}
	upgraded, valid := checkpoint.Parse(string(match.Checkpoint))
	if !valid || upgraded.Version != 2 || upgraded.V2.NativeProjection == nil || len(upgraded.V2.NativeProjection.Messages) != 2 {
		t.Fatalf("converted checkpoint was not upgraded with native identities: %+v", upgraded)
	}
}

func TestVerifyUpgradedPrefixRejectsChangedProjectedHistory(t *testing.T) {
	db := fixture(t)
	thread := builtinAdoptionThread(domain.SourceCodex)
	thread.ResumeCursor = map[string]any{"threadId": "native-session"}
	full, err := BuildPlanWithRuntimeOptions(thread, "native-session", "p-1", "codex", thread.Model, map[string]any{}, false, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = AppendPlan(context.Background(), db, full); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.text','changed') WHERE role='assistant'`); err != nil {
		t.Fatal(err)
	}
	saved, _ := checkpoint.ForThread(thread)
	checkpointJSON, _ := json.Marshal(saved)
	if _, err = VerifyUpgradedPrefix(context.Background(), db, thread, full, UpgradedExpectation{
		ThreadID: "native-session", ProjectID: "p-1", ProviderInstanceID: "codex", SourceSessionID: thread.SourceSessionID,
		IdentitySeed: thread.SourceKey, SourceFingerprint: "same", CurrentFingerprint: "same", Checkpoint: checkpointJSON,
		Resumable: true, NativeThreadID: "native-session",
	}, ""); err == nil {
		t.Fatal("accepted a converted task with changed transcript content")
	}
}
