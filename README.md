# t3-import

`t3-import` is a local Go tool for importing Codex and Claude Code conversation history into [T3 Code](https://github.com/pingdotgg/t3code). It includes a command line interface and a Bubble Tea terminal interface. Source discovery, transcript parsing, SQLite access, backups, cache reset, and recovery all run in the Go application.

## Install

Install Go 1.27.2 or newer, then install both commands:

```sh
go install github.com/runinit/t3-syncaroo/cmd/t3-import@v1.0.0
go install github.com/runinit/t3-syncaroo/cmd/t3-import-tui@v1.0.0
```

The `t3-import` command starts the TUI when run without arguments. It finds `t3-import-tui` on `PATH`; set `T3_IMPORT_TUI` if you installed the TUI somewhere else.

The release workflow publishes binaries for Linux, macOS, and Windows (amd64 and arm64) to [GitHub Releases](https://github.com/runinit/t3-syncaroo/releases) when a `v1.0.*` tag is pushed. The CLI works with `--json` for scripts and automation.

## Use the TUI

```sh
t3-import
```

The guided flow selects a source, workspace, provider, and sessions, then shows a review before a confirmed write. Use arrows to navigate, Space to select, `a` to toggle eligible sessions, `/` to search, and Enter to continue. Mouse clicks select rows and actions; the wheel scrolls. Escape returns from read-only screens, and a confirmed write runs to completion. The result screen offers to launch T3 Code.

The TUI uses Bubble Tea with mouse reporting, responsive Lip Gloss layouts, loading animation, and separate cancellable reads and protected writes.

## Use the CLI

List sessions and inspect a conversation:

```sh
t3-import list --source codex --workspace /path/to/project
t3-import show --source claude --thread <session-id>
```

Preview and confirm an import, sync, or replacement:

```sh
t3-import preview --source codex --workspace /path/to/project --thread <session-id>
t3-import import --source codex --workspace /path/to/project --thread <session-id> --yes
t3-import sync --source claude --workspace /path/to/project --all --yes
t3-import replace --source codex --workspace /path/to/project --thread <session-id> --yes
```

Other useful commands:

```sh
t3-import providers --source codex
t3-import doctor --json
t3-import cache-reset --yes
t3-import launch
t3-import --version
```

`import`, `sync`, and `replace` accept repeatable `--thread <id>` options or `--all`. Add `--dry-run` to inspect a write without confirmation. `--since <date>` filters discovery, and `--include-incomplete` includes incomplete source sessions in import previews. Use `--t3-home`, `--db`, `--attachments-dir`, and `--provider-instance` to override target paths and provider selection. Add `--json` to emit a single JSON response on stdout; diagnostics are written to stderr.

## Safety and supported T3 profiles

Close T3 Code before importing, syncing, replacing, or resetting its cache. The tool refuses writes while T3 is running. Before a database write it checks the target profile and makes a verified SQLite backup. It never runs T3 migrations and rejects unknown schemas.

The Go implementation supports the legacy T3 migration profiles 40–53 and the pinned v2 schema profile at migration 61. Compatibility with later T3 versions is not implied. See the [v2 acceptance record](docs/t3-v2-acceptance.md) for the pinned profile and the limits of the historical acceptance evidence.

Writes append canonical events and maintain the importer’s recovery ledger. T3 rebuilds its projections on launch for legacy profiles. For the pinned v2 profile, the importer writes through a Go implementation of T3’s event and projection contract. Successful writes back up and reset T3’s rebuildable IndexedDB cache by default. Local image attachments are copied atomically; remote images are referenced but not downloaded.

`sync` checks that previously imported history remains an exact prefix before appending settled turns. `replace` creates a complete new task and soft-deletes the old task with a tombstone event. Both operations preserve recoverable backups and refuse ambiguous history.

## Development

Run the Go checks from the repository root:

```sh
go test ./...
go vet ./...
go build ./cmd/t3-import ./cmd/t3-import-tui
```

The release workflow builds static binaries for Linux, macOS, and Windows on amd64 and arm64, then attaches them to GitHub Releases for `v1.0.*` tags. Historical TypeScript implementation and validation notes are kept in the documentation as reference; they are not part of the application or build.
