package domain

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

func TestCanonicalConversationJSONFixture(t *testing.T) {
	want, err := os.ReadFile("testdata/canonical-conversation.json")
	if err != nil {
		t.Fatal(err)
	}
	var conversation CanonicalConversation
	if err := json.Unmarshal(want, &conversation); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	if !conversation.Summary.Source.Valid() {
		t.Fatalf("unexpected source %q", conversation.Summary.Source)
	}
	if len(conversation.Threads) != 1 || !conversation.Threads[0].Turns[0].Status.Terminal() {
		t.Fatal("fixture did not decode canonical turn")
	}
	encoded, err := json.Marshal(conversation)
	if err != nil {
		t.Fatalf("encode fixture model: %v", err)
	}
	if !sameJSON(t, want, encoded) {
		t.Fatalf("canonical JSON changed\nwant: %s\n got: %s", want, encoded)
	}
}

func sameJSON(t *testing.T, a, b []byte) bool {
	t.Helper()
	var left, right bytes.Buffer
	if err := json.Compact(&left, a); err != nil {
		t.Fatal(err)
	}
	if err := json.Compact(&right, b); err != nil {
		t.Fatal(err)
	}
	return bytes.Equal(left.Bytes(), right.Bytes())
}
