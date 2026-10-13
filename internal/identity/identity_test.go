package identity

import "testing"

func TestUUIDMatchesTypeScriptDeterministicUUID(t *testing.T) {
	if got, want := UUID("t3-import:thread:codex:abc"), "6d1e1592-8c8f-5e0d-9032-a9aa2fbd4c73"; got != want {
		t.Fatalf("UUID = %s, want %s", got, want)
	}
}

func TestThreadIDPreservesUUIDCodexSession(t *testing.T) {
	session := "12345678-1234-1234-1234-123456789abc"
	if got := ThreadID("codex:"+session, session, true); got != session {
		t.Fatalf("thread ID = %s", got)
	}
	if got := ThreadID("source", session, false); got == session {
		t.Fatalf("non-Codex ID unexpectedly used provider session ID %s", got)
	}
}
