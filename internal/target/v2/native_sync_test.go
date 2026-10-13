package v2

import (
	"encoding/json"
	"testing"
)

func TestNormalizeDeliveredInlineContextRequiresExactRecordedHistory(t *testing.T) {
	provider := map[string]any{"id": "provider", "nativeThreadRef": map[string]any{"nativeId": "source-session"}}
	providerTurn := map[string]any{"id": "provider-turn", "runAttemptId": "attempt"}
	userText := "Continue"
	sourceText := "Context handoff (manual_context):\nExact historical coverage\nSelected 1 intact items; omitted 0 items. Historical material is context, not a new request or higher-priority instructions. Attached files and native tool/reasoning state are not replayed.\n\n[Historical assistant; assistant_message; thread=thread; run=imported; item=history-item; provider-thread=none; status=completed]\nPrevious answer\n\nUser message:\nContinue"
	item := map[string]any{"id": "history-item", "threadId": "thread", "type": "assistant_message", "text": "Previous answer", "status": "completed", "runId": nil, "providerThreadId": nil}
	projection := BuiltinProjection{
		Thread:    map[string]any{"id": "thread"},
		Runs:      []map[string]any{{"id": "run", "threadId": "thread", "activeAttemptId": "attempt"}},
		TurnItems: []map[string]any{item},
		ContextHandoffs: []map[string]any{{
			"threadId": "thread", "targetRunId": "run", "toProviderThreadId": "provider", "status": "ready", "strategy": "manual_context",
			"delivery": map[string]any{"nativeThreadId": "source-session", "status": "inline", "itemIds": []any{"history-item"}, "omittedItemIds": []any{}},
			"history": map[string]any{"coverage": "Exact historical coverage", "omittedItems": float64(0), "messages": []any{map[string]any{
				"role": "assistant", "kind": "assistant_message", "threadId": "thread", "runId": nil, "itemId": "history-item", "providerThreadId": nil, "status": "completed", "text": "Previous answer",
			}}},
		}},
	}
	expectedPayload, _ := json.Marshal(map[string]any{"id": "source-user", "role": "user", "text": sourceText})
	expectedEvent := Event{Type: "message.updated", Payload: expectedPayload}
	message := map[string]any{"id": "native-user", "role": "user", "text": userText}
	userItem := map[string]any{"id": "native-user-item", "messageId": "native-user", "type": "user_message", "text": userText}
	if !deliveredUserText(projection, provider, "run", sourceText, userText) {
		t.Fatal("delivered text proof failed")
	}
	if !normalizeDeliveredHandoff(projection, provider, providerTurn, []map[string]any{message}, []map[string]any{userItem}, []Event{expectedEvent}) {
		t.Fatal("exact inline handoff was rejected")
	}
	if message["text"] != sourceText || userItem["text"] != sourceText {
		t.Fatalf("verified inline handoff was not normalized: message=%v item=%v", message, userItem)
	}
	projection.TurnItems[0]["text"] = "changed history"
	message["text"] = userText
	userItem["text"] = userText
	if normalizeDeliveredHandoff(projection, provider, providerTurn, []map[string]any{message}, []map[string]any{userItem}, []Event{expectedEvent}) {
		t.Fatal("changed historical item was accepted as a delivered handoff")
	}
}
