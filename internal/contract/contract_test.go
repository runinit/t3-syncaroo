package contract

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"github.com/runinit/t3-syncaroo/internal/domain"
)

func TestImportResultJSONFixture(t *testing.T) {
	want, err := os.ReadFile("testdata/import-result.json")
	if err != nil {
		t.Fatal(err)
	}
	var result domain.ImportRunResult
	if err := json.Unmarshal(want, &result); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	if result.SchemaVersion != 1 || result.Status != "imported" || result.Backup != nil {
		t.Fatalf("unexpected fixture values: %#v", result)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("encode result: %v", err)
	}
	if !sameJSON(want, encoded) {
		t.Fatalf("import result JSON changed\nwant: %s\n got: %s", want, encoded)
	}
}

func TestResultEnvelopeShape(t *testing.T) {
	got, err := json.Marshal(ResultEnvelope[json.RawMessage]{SchemaVersion: 1, Result: json.RawMessage(`{"status":"ok"}`)})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"schemaVersion":1,"result":{"status":"ok"}}`
	if string(got) != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

func sameJSON(a, b []byte) bool {
	var left, right bytes.Buffer
	if json.Compact(&left, a) != nil || json.Compact(&right, b) != nil {
		return false
	}
	return bytes.Equal(left.Bytes(), right.Bytes())
}
