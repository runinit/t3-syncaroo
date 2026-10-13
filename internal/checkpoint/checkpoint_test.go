package checkpoint

import (
	"testing"

	"github.com/runinit/t3-syncaroo/internal/domain"
)

func TestSemanticHashesMatchTypeScriptCanonicalJSON(t *testing.T) {
	turn := domain.CanonicalTurn{
		ID: "turn-1", StartedAt: "2026-01-01T00:00:00.000Z",
		CompletedAt: stringPointer("2026-01-01T00:00:01.000Z"), Status: domain.TurnCompleted,
		User:       domain.CanonicalMessage{SourceID: "u1", Role: "user", Text: "hello", Timestamp: "2026-01-01T00:00:00.000Z", Attachments: []domain.SourceAttachment{}},
		Assistant:  []domain.CanonicalMessage{{SourceID: "a1", Role: "assistant", Text: "world", Timestamp: "2026-01-01T00:00:01.000Z", Attachments: []domain.SourceAttachment{}}},
		Activities: []domain.CanonicalActivity{{SourceID: "tool1", Tone: domain.ToneTool, Kind: "tool-call", Summary: "run", Payload: map[string]any{"z": 1, "a": "<&"}, Timestamp: "2026-01-01T00:00:00.500Z"}},
		Plans:      []domain.CanonicalPlan{},
	}
	v1, err := LegacyTurnSemanticHash(turn)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := v1, "ab0a37af4135780b2585056f75b309bc13ee18631b63e128b003a03810fce39a"; got != want {
		t.Errorf("legacy hash = %s, want TypeScript golden %s", got, want)
	}
	v2, err := TurnSemanticHash(turn)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := v2, "bae698115d27a73e788978073fe2bf7990d59a75abc380ac58feb121449ddcbc"; got != want {
		t.Errorf("v2 hash = %s, want TypeScript golden %s", got, want)
	}
}

func TestCheckpointKeepsOnlyTerminalTurnsAndParsesBothVersions(t *testing.T) {
	thread := domain.CanonicalThread{Turns: []domain.CanonicalTurn{
		{ID: "done", Status: domain.TurnCompleted},
		{ID: "active", Status: domain.TurnInProgress},
	}}
	checkpoint, err := ForThread(thread)
	if err != nil {
		t.Fatal(err)
	}
	if checkpoint.Version != 2 || len(checkpoint.Turns) != 1 || checkpoint.Turns[0].ID != "done" {
		t.Fatalf("unexpected checkpoint: %+v", checkpoint)
	}
	for _, raw := range []string{
		`{"version":1,"turns":[{"id":"a","hash":"h"}]}`,
		`{"version":2,"turns":[{"id":"a","status":"failed","hash":"h"}]}`,
	} {
		if _, ok := Parse(raw); !ok {
			t.Errorf("Parse(%s) rejected a supported checkpoint", raw)
		}
	}
	if _, ok := Parse(`{"version":3,"turns":[]}`); ok {
		t.Fatal("unknown checkpoint version was accepted")
	}
}

func stringPointer(value string) *string { return &value }
