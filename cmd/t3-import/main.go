// Native Go command line interface for the shared application service.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime/debug"
	"strings"

	"github.com/runinit/t3-syncaroo/internal/app"
	"github.com/runinit/t3-syncaroo/internal/domain"
	"github.com/runinit/t3-syncaroo/internal/target/config"
)

type caller func(context.Context, config.TargetPaths, app.Request) (json.RawMessage, error)

// version is set by release builds. Go install embeds the module version in
// build info, which is used when no explicit release value is present.
var version = "dev"

type options struct {
	json, confirmed, includeIncomplete  bool
	dryRun, all, noResume, noCacheReset bool
	t3Home, db, attachments, provider   string
	source, workspace, mode, since      string
	threads                             stringList
}
type stringList []string

func (s *stringList) String() string     { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error { *s = append(*s, v); return nil }

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr, realCall)) }

var launchTUI = func() error {
	name := os.Getenv("T3_IMPORT_TUI")
	if name == "" {
		name = "t3-import-tui"
	}
	path, err := exec.LookPath(name)
	if err != nil {
		return fmt.Errorf("cannot launch T3 Import TUI: %s was not found on PATH (set T3_IMPORT_TUI to its path)", name)
	}
	cmd := exec.Command(path)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

func realCall(ctx context.Context, paths config.TargetPaths, request app.Request) (json.RawMessage, error) {
	return app.New(paths).Call(ctx, request)
}

func run(args []string, stdout, stderr io.Writer, call caller) int {
	if len(args) == 0 {
		if err := launchTUI(); err != nil {
			fmt.Fprintln(stderr, err)
			return 6
		}
		return 0
	}
	if args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		writeUsage(stdout)
		return 0
	}
	command := args[0]
	if command == "--version" || command == "-v" {
		fmt.Fprintf(stdout, "t3-import %s (protocol %d)\n", buildVersion(), app.ProtocolVersion)
		return 0
	}
	valid := map[string]bool{"version": true, "doctor": true, "preflight": true, "list": true, "catalog": true, "providers": true, "show": true, "preview": true, "import": true, "sync": true, "replace": true, "launch": true, "cache-reset": true}
	if !valid[command] {
		fmt.Fprintf(stderr, "unknown command %q\n", command)
		writeUsage(stderr)
		return 2
	}
	var o options
	fs := flag.NewFlagSet("t3-import "+command, flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.BoolVar(&o.json, "json", false, "write JSON to stdout")
	fs.StringVar(&o.t3Home, "t3-home", "", "T3 home directory")
	fs.StringVar(&o.db, "db", "", "T3 state database path")
	fs.StringVar(&o.attachments, "attachments-dir", "", "T3 attachments directory")
	fs.StringVar(&o.provider, "provider-instance", "", "T3 provider instance")
	fs.StringVar(&o.source, "source", "", "codex or claude")
	fs.StringVar(&o.workspace, "workspace", "", "workspace path")
	fs.StringVar(&o.mode, "mode", "auto", "auto, sync, or replace")
	fs.Var(&o.threads, "thread", "source conversation ID (repeatable)")
	fs.BoolVar(&o.all, "all", false, "select every matching conversation")
	fs.BoolVar(&o.confirmed, "yes", false, "confirm the requested write")
	fs.BoolVar(&o.includeIncomplete, "include-incomplete", false, "include incomplete source sessions")
	fs.StringVar(&o.since, "since", "", "ISO date/time")
	fs.BoolVar(&o.dryRun, "dry-run", false, "preview changes without writing")
	fs.BoolVar(&o.noResume, "no-resume", false, "do not preserve resumable source cursors")
	fs.BoolVar(&o.noCacheReset, "no-cache-reset", false, "keep T3's rebuildable cache after writes")
	if err := fs.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if fs.NArg() != 0 {
		fmt.Fprintf(stderr, "unexpected argument %q\n", fs.Arg(0))
		return 2
	}
	if command == "version" {
		if o.json {
			if err := json.NewEncoder(stdout).Encode(map[string]any{"schemaVersion": 1, "version": buildVersion(), "protocolVersion": app.ProtocolVersion}); err != nil {
				fmt.Fprintln(stderr, err)
				return 6
			}
		} else {
			fmt.Fprintf(stdout, "t3-import %s (protocol %d)\n", buildVersion(), app.ProtocolVersion)
		}
		return 0
	}
	req := app.Request{Action: command, Source: domain.SourceName(o.source), Workspace: o.workspace, Mode: app.Mode(o.mode), SessionIDs: []string(o.threads), Provider: o.provider, Confirmed: o.confirmed, IncludeIncomplete: o.includeIncomplete, Since: o.since, All: o.all, DryRun: o.dryRun, NoResume: o.noResume}
	if o.noCacheReset {
		reset := false
		req.ResetCache = &reset
	}
	if command == "list" {
		req.Action = "catalog"
	}
	if command == "show" {
		req.Action = "show"
		if len(o.threads) != 1 {
			fmt.Fprintln(stderr, "show requires exactly one --thread")
			return 2
		}
		req.ThreadID = o.threads[0]
	}
	if command == "cache-reset" {
		req.Action = "cache-reset"
	}
	if command == "import" || command == "sync" || command == "replace" {
		req.Action = "execute"
		req.Mode = app.Mode(command)
		if command == "import" {
			req.Mode = app.ModeAuto
		}
	}
	// Resolve explicit path flags for this invocation without changing the service API.
	paths := config.ResolveTargetPaths(config.TargetOverrides{T3Home: o.t3Home, DBPath: o.db, AttachmentsDir: o.attachments, ProviderInstance: o.provider})
	data, err := call(context.Background(), paths, req)
	if err != nil {
		if o.json {
			_ = json.NewEncoder(stdout).Encode(map[string]any{"schemaVersion": 1, "status": "error", "error": err.Error()})
		} else {
			fmt.Fprintln(stderr, err)
		}
		return exitCode(err)
	}
	if o.json {
		if _, err := stdout.Write(append(data, '\n')); err != nil {
			fmt.Fprintln(stderr, err)
			return 6
		}
	} else {
		var value any
		if json.Unmarshal(data, &value) == nil {
			pretty, _ := json.MarshalIndent(value, "", "  ")
			fmt.Fprintln(stdout, string(pretty))
		} else {
			fmt.Fprintln(stdout, string(data))
		}
	}
	if command == "sync" || command == "replace" {
		var result struct {
			HasConflicts bool `json:"hasConflicts"`
		}
		if json.Unmarshal(data, &result) == nil && result.HasConflicts {
			return 7
		}
	}
	return 0
}

func exitCode(err error) int {
	if errors.Is(err, flag.ErrHelp) {
		return 0
	}
	if code, ok := app.ExitCode(err); ok {
		return code
	}
	message := strings.ToLower(err.Error())
	for _, needle := range []string{"required", "must be", "unknown application action", "source is required", "workspace is required", "mode must", "invalid iso", "execute requires confirmed"} {
		if strings.Contains(message, needle) {
			return 2
		}
	}
	return 6
}
func writeUsage(w io.Writer) {
	fmt.Fprintln(w, "Usage: t3-import <command> [options]")
	fmt.Fprintln(w, "Commands: version, preflight, doctor, list, providers, show, preview, import, sync, replace, cache-reset, launch")
	fmt.Fprintln(w, "Common options: --json --t3-home PATH --db PATH --attachments-dir PATH --provider-instance ID")
	fmt.Fprintln(w, "Write options: --yes --dry-run --no-cache-reset --no-resume")
}

func buildVersion() string {
	if version != "" && version != "dev" {
		return version
	}
	info, ok := debug.ReadBuildInfo()
	if ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version
	}
	return version
}
