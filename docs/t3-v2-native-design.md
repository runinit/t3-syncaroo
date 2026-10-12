# Native T3 v2 integration design

Status: implementation design for the exact T3 Code nightly source commit
`ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e` (reported by the installed build as
`0.0.46-nightly.20261011.2980`). This design supplements
[the support specification](t3-v2-support-spec.md) and
[source research](t3-v2-support-research.md).

Historical design baseline for `.2980`. The approved implementation target is
now `.2994`; use [the nightly comparison](t3-v2-nightly-update-research.md)
for source changes, and do not treat the earlier proof as `.2994` runtime
acceptance.

## Decision

Add a separate v2 target adapter that translates the importer's existing
canonical conversations into the pinned v2 contracts and calls T3's
`EventSinkV2`. Keep the current legacy target path for migrations 40–53. Do not
write v2 event rows, projections, provider bindings, or projection metadata with
SQL. The native sink is the supported write boundary: it appends the v2-marked
events, applies projections, normalizes turn-item positions, advances projection
metadata, and commits these database changes together.

The synthetic proof at [scripts/compatibility/v2-proof/run.mjs](../scripts/compatibility/v2-proof/run.mjs)
used the pinned migrations and actual sink. It reopened the database and read
back the thread, message, and native provider-session reference through T3's
projection store. It also verified preflight recognition of an existing
deterministic thread and rollback of a batch whose later event ID collided.
This proves the native persistence seam, not UI rendering, asset handling,
provider continuation, or a shippable npm bundle.

## Integration shape

Keep source discovery, canonical normalization, checkpoint comparison, and
result reporting shared. Add a v2 target implementation alongside the current
legacy SQL implementation, selected only after target resolution and validation.
Avoid moving all target behavior behind a new generic framework; extract only
the planning and reads that both implementations actually share.

The v2 adapter should own a narrow lifecycle: open the pinned SQLite client
without running migrations; expose the projection/event reads needed by import,
sync, and replacement planning; accept a batch of typed v2 events; call
`EventSinkV2.write` once for that batch; return stored sequence numbers; and
close the client in `finally`. Map t3-import's planned concepts explicitly to
v2 payloads. Legacy event names and JSON payloads are not a compatible wire
format. In particular, encode T3 v2 thread, message, turn-item, run/activity,
plan, attachment, provider-thread, and provider-session structures using the
pinned contracts. Use the native provider-thread strong reference and
`nativeConversationHeadRef` for eligible continuation; do not copy the legacy
`provider_session_runtime` row model into v2.

Use the event sink for project creation and thread changes so projections and
event sequence metadata stay aligned. The proof's direct `ProjectStore.apply`
was only fixture setup; production import must not copy that shortcut. Preflight
thread/source identity and deterministic event IDs before calling the sink:
the pinned event store performs plain inserts, so a duplicate event ID fails the
transaction rather than becoming an idempotent upsert.

### Database lifecycle and recovery

1. Resolve and display the selected target. When both files exist, prefer a
   validated v2 target; if it is invalid or unsupported, stop instead of
   silently selecting legacy. Preserve explicit `--db` behavior.
2. Require T3 closed and acquire the existing per-state-directory importer
   lock. Validate SQLite integrity and a v2 profile signature before any write.
3. Open the target read-only for preview, and use the v2 projection store and
   event store for existence, ownership, checkpoint, and adoption checks. Close
   that client before producing the backup.
4. For a write, make and verify the existing `VACUUM INTO` backup before opening
   the v2 writer. The closed-T3 guard avoids a second live writer and makes the
   snapshot stable despite SQLite WAL mode. Do not run T3 migrations from the
   importer.
5. Materialize assets into the existing staging directory before the event
   transaction. Submit one native sink batch for the selected operation. If it
   fails, the sink transaction rolls back events and projections; remove only
   asset files created by this run. Retain the verified backup.
6. Close and reopen through the pinned read adapter, verify the written
   projections and native binding, then record the external ledger. If the
   process stops after the native commit but before ledger update, recover by
   matching deterministic thread identity and source history against native
   projections/events. Never replay the batch merely because the ledger is
   missing.

The event batch is atomic within SQLite; filesystem assets and the separate
ledger cannot share that transaction. Preserve the existing staging/cleanup and
ledger-recovery model, and make the committed-thread/ledger-missing window an
explicit recovery scenario. Do not promise automatic database rollback after a
successful sink commit if a later verification step fails; report the backup and
give recovery a conservative identity check.

## Target recognition and upgrade reconciliation

Keep the legacy profile unchanged at migrations 40–53. Add a separately named
nightly-v2 profile. Against the pinned migration-61 database, the adapter uses
these required table/column groups:

- `effect_sql_migrations(migration_id, name, created_at)`, with max ID 61,
  migration 55 named `OrchestrationV2`, and migration 61 named
  `PullRequestReviewGuides`;
- `orchestration_events(sequence, event_id, aggregate_kind, stream_id,
  stream_version, event_type, occurred_at, command_id, causation_event_id,
  correlation_id, actor_kind, payload_json, metadata_json,
  application_event_version)`;
- `orchestration_v2_projection_metadata(projection_name, schema_version,
  last_sequence, updated_at)`;
- `projection_projects(project_id, workspace_root, deleted_at)`;
- v2 thread projections `orchestration_v2_projection_threads(thread_id,
  project_id, title, default_provider, runtime_mode, interaction_mode,
  active_provider_thread_id, created_at, updated_at, archived_at, deleted_at,
  payload_json, provider_instance_id)`;
- the read/write projections used by the pinned stores:
  `orchestration_v2_projection_messages(message_id, thread_id, run_id, node_id,
  role, streaming, created_at, updated_at, payload_json)`,
  `orchestration_v2_projection_turn_items(turn_item_id, thread_id, run_id,
  node_id, provider_thread_id, provider_turn_id, parent_item_id, ordinal, type,
  status, updated_at, payload_json)`,
  `orchestration_v2_turn_item_positions(thread_id, turn_item_id, ordinal)`,
  `orchestration_v2_projection_provider_threads(provider_thread_id, thread_id,
  owner_node_id, provider, provider_session_id, status, first_run_ordinal,
  last_run_ordinal, updated_at, payload_json, driver, provider_instance_id)`,
  `orchestration_v2_projection_provider_sessions(provider_session_id, thread_id,
  provider, status, model, updated_at, payload_json, driver,
  provider_instance_id)`,
  `orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider,
  provider_thread_id, status, requested_at, completed_at, payload_json,
  provider_instance_id)`,
  `orchestration_v2_projection_run_attempts(attempt_id, thread_id, run_id,
  attempt_ordinal, root_node_id, provider, provider_thread_id, provider_turn_id,
  status, payload_json, provider_instance_id)`,
  `orchestration_v2_projection_nodes(node_id, thread_id, run_id, parent_node_id,
  root_node_id, kind, status, provider_thread_id, provider_turn_id,
  runtime_request_id, checkpoint_scope_id, started_at, completed_at,
  payload_json)`, and
  `orchestration_v2_projection_provider_turns(provider_turn_id, thread_id,
  provider_thread_id, node_id, run_attempt_id, ordinal, status, started_at,
  completed_at, payload_json)`.

The event-version column must exist; a new migration-61 database can have no
events yet, so validation must not require an existing row with version 2. Once
events exist, v2 writes go through the sink and carry version 2. Require the
`thread-projections` metadata row with schema version supported by the pinned
helper (fresh migrated homes begin at version 1; after the proof write it is 2),
and treat a stale `last_sequence` as a write-safety issue rather than silently
falling back to legacy. Reject migrations 54–60 and all other profiles until
individually validated. Migration 61 alone does not prove an executable's exact
build: the database has no reliable source commit marker. This is compatibility
with the pinned schema/contract profile, not a claim about binary identity.

For default selection, preserve explicit `--db` as the exact database path. With
no explicit database, check `<T3 home>/userdata/statev2.sqlite` first. If it
exists, select it and validate it; an invalid or unsupported v2 file is a hard
error even when a legacy `state.sqlite` is also present. If it does not exist,
use `state.sqlite` and the unchanged 40–53 validator. If neither exists, retain
the current not-found path behavior for `state.sqlite`. `--t3-home` and
`T3CODE_HOME` continue to set the containing home. Keep both databases in the
same state directory so existing attachment/runtime path derivation remains
valid. Generalize the `--db` help text from `state.sqlite` to “T3 state database”.

The selection is performed by `resolveTargetPaths` or a synchronous profile
resolver composed with it; do not auto-select based only on migration number.
The selected path must be displayed in `doctor`, the TUI before selection/write,
the interactive write confirmation, and a pre-write CLI status line (stderr
when `--json` keeps stdout machine-readable). Operation results continue to
include `target` and `migration`. Explicit overrides bypass automatic selection
only; the database they name still has to validate as one of the supported
profiles. T3 closed/runtime checks remain rooted at the selected `stateDir`.

The pinned native SQLite client itself checks for Node 22.16+, 23.11+, or 24+.
Gate only v2 operations at that runtime requirement and report the detected and
minimum versions before launching the helper. Retain the package's existing
`node >=22` engine for legacy 40–53 users.

Map existing legacy ledger records to v2 targets without treating old event
sequence numbers as v2 sequence numbers. Reconcile by target-independent source
identity, source fingerprint/checkpoint, deterministic old thread ID, and
project ownership. Read converted legacy threads through v2 projections; their
IDs can survive, but their rich old events and runtime bindings may not. If
history is incomplete after conversion or event compaction, return a per-session
conflict and preserve the task. Built-in T3 imports are adoptable only after
exact source and canonical history comparison; its `historyOrigin` marker alone
is not proof of matching history.

## Distribution decision and blocker

The pinned proof imports actual source modules from a locally extracted T3
checkout and uses Effect 4.0.2. Research found the contracts package is marked
private but its source is MIT licensed. The proof producer reports roughly
444 KB for the selected core source before transitive dependencies; the filtered
pnpm install resolved 284 packages and occupied about 557 MB in the pnpm store.
That install is feasibility evidence only, not a distributable bundle or a
measure of the final package.

Preferred candidate: vendor only the pinned contract/sink/store/SQLite source
closure under a clearly versioned compatibility directory, then build a
dedicated `dist` helper entry point that runs in a child Node process. The
helper owns its Effect runtime and native SQLite connection; the parent passes
typed JSON requests and receives structured results. This keeps the legacy
better-sqlite3 connection out of the v2 writer lifecycle and gives packaging a
clean executable boundary. Bundle or otherwise include only the traced
production dependency closure, and retain T3's MIT copyright/license notices
plus a generated list of bundled third-party licenses. Keep the helper's public
interface to `inspect/read/write/close`; do not export or imitate T3's private
workspace API as a general SDK. Pin the source commit and dependency lock, and
record the generated artifact hash.

This candidate is not yet proven shippable: prove that the production dependency
closure can be bundled and invoked from a clean npm consumer install on each
supported platform, with no T3 checkout, pnpm store, or development-only module
resolution. Check `npm pack --dry-run`, unpack and execute the package against a
synthetic v2 home, verify native projection and rollback, inspect package size,
and audit the included license notices. If tree-shaking the source closure
cannot produce a maintainable artifact, the fallback is a separately installed
helper built and released from the same pinned source; that adds platform and
release coordination and should not be chosen without its own packaging proof.
Do not ship a helper that reaches into the user's T3 installation at runtime.
Make this the first implementation slice: a red clean-consumer package check,
then a bundled helper that migrates a synthetic home, writes through the native
sink, closes/reopens, and proves readback plus duplicate-preflight rollback.
Only after the packed helper passes should the CLI add v2 selection and import
writes; this avoids building product behavior on an integration that cannot be
distributed.

## Operation seams and implementation slices

The existing public operation seams are `resolveTargetPaths` and
`validateTargetDatabase` for target selection; `importConversations` for fresh
imports; `inspectConversationSync` / `syncConversations` for synchronization;
and `inspectConversationReplacement` / `replaceConversations` for replacement.
Add v2 behavior beneath these operations and preserve their CLI/TUI result
contracts, extending structured results where per-session outcome reasons are
needed.

1. **Target profile and v2 reader.** Add deterministic dual-database selection,
   v2 validation, migration/profile reporting, and projection/event read access.
   Existing coverage in `test/schema.test.ts` already generates every upstream
   legacy schema 40–53 and checks doctor output and write refusal for 39/54.
   Preserve that coverage. Add target-resolver tests using small table fixtures
   for path precedence only; do not pretend hand-built tables are a native v2
   compatibility fixture. Once the helper is distributable, use its actual
   migrations 1–61 to create a temporary v2 database, then mutate that disposable
   database to remove a required column, remove/rename the v2 marker column, or
   set migration 54–60/62. Cover valid v2 alone, valid v1 alone, both present
   (v2 selected), invalid v2 beside valid v1 (hard error with no fallback), no
   database (legacy not-found path), and explicit `--db` to each profile. Test
   path visibility in doctor/TUI/interactive confirmation and ensure no DB,
   attachment, or ledger mutation on invalid targets. Add runtime gate cases for
   22.15 (refuse v2), 22.16 and 23.11/24+ (allow v2), while legacy 22.0 remains
   allowed.
2. **Fresh import encoder and sink.** Encode one representative Codex and Claude
   conversation, including terminal states, activity, plan, and supported
   attachment references; submit through the sink and verify close/reopen.
   Red checks must fail when the v2 task projection or provider binding is
   absent. Add duplicate-preflight and sink-rollback checks, then exercise the
   real importer operation in the synthetic pinned home.
3. **Upgrade and built-in adoption.** Recognize pre-upgrade identities and
   converted task projections; compare exact source history before adopting a
   built-in import. Red checks cover no duplicate for a verified match and an
   actionable conflict for divergent or compacted history.
4. **Synchronization.** Reuse checkpoint and turn-semantic comparison while
   reading native projections; append only settled new source turns and adopt
   T3-created matching turns. Red checks cover append, up-to-date repeat,
   continued turn adoption, changed-history conflict, and missing-ledger recovery
   without reimport.
5. **Replacement and recovery.** Write replacement thread and retire-old-task
   events in one sink transaction, transfer only validated native continuation
   references, and update the ledger after post-commit verification. Red checks
   cover failure rollback, one canonical task, repeatability, resume, and
   conservative recovery after commit-before-ledger interruption.
6. **Per-session outcomes and packaging.** Make deferred, already-imported,
   conflict, and failure outcomes actionable; then pass clean-package, pinned
   runtime, isolated desktop, and minimal real-provider continuation checks from
   the support specification. The real-provider checks remain required for a
   full support claim; the synthetic sink proof is not a substitute.

## Remaining evidence limits

- Pinned EventSink persistence, projection reads after reopen, duplicate
  preflight, and transaction rollback passed on synthetic data.
- A production-size npm artifact and license manifest have not been produced.
- The pinned `nodeSqliteClient` requires Node.js 22.16+, 23.11+, or 24+; v2
  operations must gate unsupported CLI runtimes while preserving the existing
  legacy path's declared Node range.
- The proof did not show T3 desktop rendering, images/plans presentation,
  provider-session resume for either provider, sync after a real continuation,
  or legacy conversion on the installed nightly.
- Native v2 event compaction and missing-ledger recovery still require tests
  against the pinned runtime before this design is complete for implementation.
