package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/runinit/t3-syncaroo/internal/app"
	"github.com/runinit/t3-syncaroo/internal/target/config"
)

func TestUsageAndUnknownCommandExit(t *testing.T) {
	var out, errOut strings.Builder
	if code := run([]string{"--help"}, &out, &errOut, nil); code != 0 || !strings.Contains(out.String(), "Usage:") {
		t.Fatalf("usage: code=%d out=%q", code, out.String())
	}
	out.Reset()
	errOut.Reset()
	if code := run([]string{"wat"}, &out, &errOut, nil); code != 2 || !strings.Contains(errOut.String(), "unknown command") {
		t.Fatalf("unknown: code=%d err=%q", code, errOut.String())
	}
}

func TestBuildVersionUsesReleaseValue(t *testing.T) {
	previous := version
	version = "v1.0.0"
	t.Cleanup(func() { version = previous })
	if got := buildVersion(); got != "v1.0.0" {
		t.Fatalf("buildVersion() = %q, want v1.0.0", got)
	}
	var out, errOut strings.Builder
	if code := run([]string{"version", "--json"}, &out, &errOut, nil); code != 0 {
		t.Fatalf("version exit=%d stderr=%q", code, errOut.String())
	}
	var response map[string]any
	if err := json.Unmarshal([]byte(out.String()), &response); err != nil || response["version"] != "v1.0.0" || response["protocolVersion"] != float64(app.ProtocolVersion) {
		t.Fatalf("version JSON=%q err=%v", out.String(), err)
	}
}

func TestNoArgsLaunchesTUIAndReportsMissingCommand(t *testing.T) {
	old := launchTUI
	defer func() { launchTUI = old }()
	var out, errOut strings.Builder
	launchTUI = func() error { return errors.New("cannot launch T3 Import TUI: t3-import-tui was not found on PATH") }
	if code := run(nil, &out, &errOut, nil); code != 6 || !strings.Contains(errOut.String(), "not found on PATH") {
		t.Fatalf("code=%d err=%q", code, errOut.String())
	}
	launchTUI = func() error { return nil }
	if code := run(nil, &out, &errOut, nil); code != 0 {
		t.Fatalf("code=%d", code)
	}
}

func TestJSONOutputAndRequestMapping(t *testing.T) {
	var out, errOut strings.Builder
	called := false
	call := func(_ context.Context, _ config.TargetPaths, req app.Request) (json.RawMessage, error) {
		called = true
		if req.Action != "show" || req.Source != "codex" || req.Workspace != "/work" || req.ThreadID != "abc" || len(req.SessionIDs) != 1 || req.SessionIDs[0] != "abc" {
			t.Fatalf("request: %#v", req)
		}
		return json.RawMessage(`{"sessions":[]}`), nil
	}
	code := run([]string{"show", "--json", "--source", "codex", "--workspace", "/work", "--thread", "abc"}, &out, &errOut, call)
	if code != 0 || !called {
		t.Fatalf("code=%d called=%v err=%s", code, called, errOut.String())
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(out.String()), &got); err != nil || got["sessions"] == nil {
		t.Fatalf("JSON=%q err=%v", out.String(), err)
	}
}

func TestNoCacheResetFlagMapsToRequest(t *testing.T) {
	var out, errOut strings.Builder
	called := false
	code := run([]string{"import", "--json", "--yes", "--no-cache-reset", "--source", "codex", "--workspace", "/work", "--thread", "session-1"}, &out, &errOut, func(_ context.Context, _ config.TargetPaths, req app.Request) (json.RawMessage, error) {
		called = true
		if req.ResetCache == nil || *req.ResetCache {
			t.Fatalf("ResetCache = %v, want explicit false", req.ResetCache)
		}
		return json.RawMessage(`{"status":"ok"}`), nil
	})
	if code != 0 || !called {
		t.Fatalf("code=%d called=%v stderr=%q", code, called, errOut.String())
	}
}

func TestDoctorUsesDoctorAction(t *testing.T) {
	var out, errOut strings.Builder
	code := run([]string{"doctor", "--json"}, &out, &errOut, func(_ context.Context, _ config.TargetPaths, req app.Request) (json.RawMessage, error) {
		if req.Action != "doctor" {
			t.Fatalf("action=%q want doctor", req.Action)
		}
		return json.RawMessage(`{"database":{},"sources":{}}`), nil
	})
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, errOut.String())
	}
}

func TestShowRequiresExactlyOneThread(t *testing.T) {
	for _, args := range [][]string{{"show"}, {"show", "--thread", "a", "--thread", "b"}} {
		var out, errOut strings.Builder
		if code := run(args, &out, &errOut, nil); code != 2 || !strings.Contains(errOut.String(), "exactly one --thread") {
			t.Fatalf("args=%v exit=%d stderr=%q", args, code, errOut.String())
		}
	}
}

func TestErrorJSONAndExitMapping(t *testing.T) {
	for _, tc := range []struct {
		message string
		err     error
		want    int
	}{{"source is required", errors.New("source is required"), 2}, {"target database incompatible", errors.New("target database incompatible"), 6}, {"unsupported T3 schema", &app.ExitError{Code: 3, Cause: errors.New("unsupported T3 schema")}, 3}, {"T3 is running", &app.ExitError{Code: 4, Cause: errors.New("T3 is running")}, 4}, {"source scan failed", &app.ExitError{Code: 5, Cause: errors.New("source scan failed")}, 5}, {"history conflict", &app.ExitError{Code: 7, Cause: errors.New("history conflict")}, 7}} {
		var out, errOut strings.Builder
		code := run([]string{"catalog", "--json"}, &out, &errOut, func(context.Context, config.TargetPaths, app.Request) (json.RawMessage, error) {
			return nil, tc.err
		})
		if code != tc.want {
			t.Fatalf("%q exit=%d want %d", tc.message, code, tc.want)
		}
		var body map[string]any
		if err := json.Unmarshal([]byte(out.String()), &body); err != nil || body["status"] != "error" {
			t.Fatalf("error JSON=%q err=%v", out.String(), err)
		}
	}
}

func TestNonJSONErrorsGoToStderr(t *testing.T) {
	var out, errOut strings.Builder
	code := run([]string{"providers", "--source", "codex"}, &out, &errOut, func(context.Context, config.TargetPaths, app.Request) (json.RawMessage, error) {
		return nil, errors.New("backend broke")
	})
	if code != 6 || out.Len() != 0 || !strings.Contains(errOut.String(), "backend broke") {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, out.String(), errOut.String())
	}
	_ = io.Discard
}

func TestConflictResponseUsesExitSeven(t *testing.T) {
	var out, errOut strings.Builder
	code := run([]string{"sync", "--yes"}, &out, &errOut, func(context.Context, config.TargetPaths, app.Request) (json.RawMessage, error) {
		return json.RawMessage(`{"hasConflicts":true}`), nil
	})
	if code != 7 {
		t.Fatalf("exit=%d want 7", code)
	}
}
