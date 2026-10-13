# Research: t3-import support for T3 Code 0.0.46 nightly

Historical research baseline: T3 Code `0.0.46-nightly.20261011.2980`, source commit
[`ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e`](https://github.com/pingdotgg/t3code/commit/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e).
The approved implementation target is now `.2994`; see
[the bounded nightly comparison](t3-v2-nightly-update-research.md). This report
does not establish runtime acceptance for `.2994`.
The user-approved scope and acceptance scenarios are in
[t3-v2-support-spec.md](t3-v2-support-spec.md) and
[t3-v2-support.md](t3-v2-support.md). This report separates source-verified facts
from implementation proposals and runtime proof still required.

## Verdict

Support is feasible, but it is a substantial new target adapter and recovery path,
not an allowed-migration-number change. The exact nightly has usable native v2
event contracts and a native event sink. That sink updates the event log,
projections, projection sequence metadata, and turn-item positions together. The
server does **not** rebuild projections from externally appended events on normal
startup, so raw SQL event inserts would leave imported threads absent or stale in
T3. A safe v2 implementation must call the pinned native `EventSinkV2` (or an
equivalent implementation proven against it) for the event transaction.

The main delivery cost is packaging: the sink is an internal T3 server service,
not a public npm API. Its implementation depends on Effect and private T3
workspace packages; `@t3tools/contracts` is marked `private` and exports source
TypeScript, and this commit pins Effect `4.0.2`. The current t3-import npm package
has no Effect runtime and publishes only `dist`, README, and LICENSE. A viable
offline release therefore needs a bundled pinned adapter plus the required
contract/projector modules and runtime dependencies, or a separately shipped
helper built from that pinned source. Either path brings explicit source and
dependency maintenance. There is no generic public RPC for arbitrary transcript/event
imports: T3's websocket import endpoint only invokes its own scanner/importer,
which imports a narrower transcript. The current spec's plan, activity, images,
and provider-binding requirements cannot be satisfied through that RPC alone.

Do not claim successful native writing, visible rendering, cache safety, or real
Codex/Claude continuation from this source review. No runtime import was executed,
no installed T3 data was opened, and no paid provider was called.

## Verified source facts

### Storage, initialization, and projection behavior

- Server path derivation selects `statev2.sqlite`; attachments are stored under
  the same `stateDir/attachments`, and the provider-status cache path is
  `baseDir/caches`. See pinned [`config.ts` lines 134–159](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/config.ts#L134-L159).
- If `statev2.sqlite` is absent and `state.sqlite` exists, initialization makes a
  SQLite backup snapshot and publishes it as the v2 database. It does this only
  when the destination does not exist. The migration guide says the databases
  diverge after this one-time copy; later history and changes do not sync between
  them. See [`initializeV2Database.ts` lines 17–52](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/persistence/initializeV2Database.ts#L17-L52)
  and the [pinned migration guide](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/docs/user/thread-migration.md#L1-L10).
- `state.sqlite` conversion does not retain the old live provider session, runs,
  checkpoints/diffs, tool activity, approvals, or proposed plans. Continuing the
  converted thread creates a fresh provider session. See [migration guide lines
  17–33](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/docs/user/thread-migration.md#L17-L33).
- Normal startup calls legacy shell reconciliation, provider runtime recovery,
  delegated task recovery, worker startup, and optional project bootstrap. The
  ordered startup function contains no projection rebuild/verify step.
  [`runOrderedV2StartupPhases` in `serverRuntimeStartup.ts`](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/serverRuntimeStartup.ts#L384-L414)
  and [its production call](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/serverRuntimeStartup.ts#L507-L539).
  `ProjectionMaintenanceV2.rebuild` exists as an explicit maintenance operation,
  but searches of production server, CLI, and runtime wiring found no startup
  caller. Its implementation deletes projection rows and replays stored events
  only when explicitly called. See
  [`ProjectionMaintenance.ts` API and verification](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/ProjectionMaintenance.ts#L31-L74)
  and [explicit rebuild implementation](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/ProjectionMaintenance.ts#L122-L195).
  Runtime composition only adds the maintenance layer to available services
  ([`runtimeLayer.ts`](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/runtimeLayer.ts#L82-L86)
  and [production layer merge](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/runtimeLayer.ts#L338-L348)).
- `ProjectionMaintenance.verify` compares the v2 event stream sequence and
  created-thread set to projected SQL rows. Its source comment says the EventSink
  writes the event, projection updates, and metadata in one transaction, and
  deliberately avoids maintaining a second projector. That establishes that
  event rows alone are not the supported persistence boundary. See
  [`ProjectionMaintenance.ts` lines 69–119](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/ProjectionMaintenance.ts#L69-L119).
- `EventSinkV2.write` normalizes turn-item positions, appends through
  `EventStoreV2`, applies each stored event through `ProjectionStoreV2`, advances
  projection metadata, and does these operations in `sql.withTransaction`; it
  publishes after commit. See
  [`EventSink.ts` lines 309–360 and 362–393](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/EventSink.ts#L309-L393)
  (transaction wrapper at [lines 232–260](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/EventSink.ts#L232-L260)).
- V2 application events use `orchestration_events` with
  `application_event_version = 2`; the `orchestration_v2_events` table name is
  not a reliable indicator of the active v2 writer. The event-store adapter
  delegates to the shared application event store. See
  [`EventStore.ts` lines 1–47](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/EventStore.ts#L1-L47)
  and [`OrchestrationEventStore.ts` lines 437–481](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/persistence/OrchestrationEventStore.ts#L437-L481).
- The SQLite layer enables WAL, a 5-second busy timeout, foreign keys, and runs
  database migrations when it opens. Backups and writes therefore need to account
  for WAL sidecars and the existing closed-T3/backup contract. See
  [`Sqlite.ts` lines 12–43](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/persistence/Sqlite.ts#L12-L43).

### Native import, event shapes, and adoption

- The built-in importer derives its thread ID as
  `import:${providerInstanceId}:${providerSessionId}` and builds an app thread
  with `historyOrigin: "v1_import"`, `activeProviderThreadId`, and a settled
  override. It emits `thread.created`, then `message.updated` and
  `turn-item.updated` for text-only user/assistant messages, then
  `provider-thread.updated`, through the EventSink. It does not synthesize runs,
  tool activity, plans, or attachments. See
  [`AgentSessionImporter.ts` lines 89–165 and 274–375](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/project/AgentSessionImporter.ts#L89-L165)
  and [lines 274–375](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/project/AgentSessionImporter.ts#L274-L375).
- If that importer finds the deterministic thread ID already present, it checks
  project ownership and `historyOrigin === "v1_import"`, then records imported
  source metadata. That check does not compare source history with the existing
  task's canonical transcript. The completed-source marker stores source and
  workspace metadata, not a content digest. See
  [`AgentSessionImporter.ts` lines 195–265](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/project/AgentSessionImporter.ts#L195-L265).
  Safe adoption therefore needs t3-import's own exact history comparison before
  it records ownership or starts sync/replacement.
- The v2 legacy importer preserves the original `thread_id` when reconciling
  shells and uses `historyOrigin: "v1_import"`; transcript import can happen
  later. Its import-progress table keys on that same thread ID. See
  [`LegacyV1ThreadImporter.ts` lines 189–240 and 443–476](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts#L189-L240)
  and [migration state](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/persistence/Migrations/OrchestrationV2/LegacyV1ImportState.ts#L1-L27).
  This makes same-ID reconciliation possible after the one-time database copy,
  but does not by itself reconcile t3-import's separate target-path ledger or
  prove the projected history has finished importing.
- Event compaction can remove all v1 events for a thread after its v2 transcript
  is imported; it also removes legacy receipts. In v2, repeated
  `message.updated` and `node.updated` events can be compacted to the newest event
  per entity, while `turn-item.updated` events are retained. Recovery must not
  depend on a complete historical event sequence or a legacy checkpoint still
  being present. See
  [`ProjectionMaintenance.ts` lines 205–320](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/ProjectionMaintenance.ts#L205-L320).
- Contracts provide `thread.created`, `message.updated`, `turn-item.updated`,
  `plan.updated`, and `provider-thread.updated`; turn-item variants include
  messages, reasoning, plans, tool activity, errors, compaction and other
  structured activity. Runs have completed/interrupted/failed/cancelled statuses.
  These schemas show candidate representations, but do not prove that each
  historical variant renders as intended or is semantically valid with a null
  run ID. See
  [`orchestrationV2.ts` run and turn-item schemas](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/packages/contracts/src/orchestrationV2.ts#L543-L589)
  and [turn-item/event schemas](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/packages/contracts/src/orchestrationV2.ts#L1407-L1507).
- T3 attachments are metadata in message/turn-item payloads plus files below
  `attachmentsDir`; the normal server path validates the image bytes, computes a
  deterministic attachment ID, and persists bytes before returning metadata.
  See [`chatAttachment.ts` lines 149–218](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/packages/contracts/src/chatAttachment.ts#L149-L218)
  and [`ws.ts` lines 364–429](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/ws.ts#L364-L429).
  A t3-import asset writer must stage and verify those files, back them up or
  journal them independently from SQLite, and clean up safely on rollback.

### Provider continuation

- Built-in import creates a strong `nativeThreadRef` with the provider driver and
  source session ID. For both Codex and Claude this is the identity needed to
  address the source session, subject to provider storage still containing it.
  See [`AgentSessionImporter.ts` lines 312–330](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/project/AgentSessionImporter.ts#L312-L330).
- Built-in import sets `nativeConversationHeadRef: null`. Claude's adapter reads
  a Claude-specific head reference and passes its native ID as
  `resumeSessionAt`; the source session ID by itself cannot encode the selected
  conversation branch/head. See
  [`ClaudeAdapterV2.ts` lines 1312–1332 and 8173–8245](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1312-L1332)
  and [query resume handling](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L8173-L8245).
  The existing t3-import Claude branch normalization must provide its saved
  `resumeCursor.resumeSessionAt` as this reference, then update it after continued
  turns. This is the last assistant-message UUID on the selected branch, which
  is not necessarily the branch leaf UUID; see local
  [`claude.ts`](../src/sources/claude.ts#L537).
- The pinned `AgentSessionImporter` also persists an old-style provider runtime
  cursor. V2 continuation is represented by the app thread's active provider
  thread plus the provider-thread native references; the runtime cursor alone is
  not enough evidence of v2 continuation. Only the provider adapter tests and a
  real disposable continuation can prove routing and execution.
- The thread migration guide confirms that v1 conversion itself does not
  recreate native provider sessions. If t3-import's old ledger has the original
  source ID and source data remain available, a v2 reconciliation can attach a
  native reference to the same thread ID. If the source session is gone or its
  branch/head cannot be selected unambiguously, exact continuation cannot be
  reconstructed from the converted text alone; sync/adoption and continuation
  need separate outcomes.

### Native API and package boundary

- The server exposes `agentSessionsImport` over its websocket, but the handler
  calls the built-in scanner/importer with a project ID. It does not accept
  t3-import's canonical normalized events, plans, activity, or arbitrary
  attachments. See [`ws.ts` lines 2706–2711](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/ws.ts#L2706-L2711).
- The native `EventSinkV2` is composed inside `runtimeLayer.ts` from internal
  EventSink, EventStore, projection, project, receipt, outbox, and turn-position
  stores; `EventSink.ts` also imports wire projection/live-stream modules. The
  server package depends on `effect` and multiple `@t3tools/*` `workspace:*`
  modules. The shared contracts package is `private: true`, exports source TS,
  and pins Effect through this workspace's `4.0.2` catalog. See
  [`runtimeLayer.ts` lines 1–110](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/runtimeLayer.ts#L1-L110),
  [`EventSink.ts` imports and layer dependencies](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/EventSink.ts#L1-L40),
  the pinned [`apps/server/package.json`](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/package.json),
  [`packages/contracts/package.json`](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/packages/contracts/package.json),
  and [`pnpm-workspace.yaml` catalog](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/pnpm-workspace.yaml#L54-L55).
- The former TypeScript t3-import published an npm package and used a
  compatibility harness built around the v1 projection API. That implementation
  and harness were retired during the Go port.

## Implementation proposal (not yet implemented or proven)

1. Preserve the existing v1 target profile for migrations 40–53. Add a distinct
   pinned v2 profile requiring the exact expected application event marker,
   projection schema version, required tables/indexes, integrity checks, and
   valid source mapping. Since a DB does not store the T3 executable's git commit,
   schema validation can establish a compatible storage shape, but cannot prove
   which server binary is installed. Continue to make the release profile
   explicit and reject unknown schema/profile combinations rather than assuming
   every future migration 54+ is compatible.
2. Add v2 target selection for `statev2.sqlite` with explicit `--db` override,
   pre-write path display, closed-server checks, verified SQLite backup, WAL-aware
   recovery, and a v2-aware cache profile. The local cache profile currently
   names only the old target; update it only after confirming which caches this
   nightly rebuilds and which must be preserved.
3. Reuse canonical Codex/Claude source normalization and ledger identity where
   proven. Generate T3 event payloads with the pinned contracts, assign stable
   ids for idempotence, persist assets first through a recoverable staged-write
   protocol, and commit thread/messages/turn-items/plans/provider binding using
   the native EventSink transaction. Keep source-session ownership and branch
   head references in the ledger so sync/replacement can detect edits and
   transfer identity deterministically.
4. Reconcile migration-era tasks by same thread ID and compare normalized
   transcript evidence before adopting. Account for T3's lazy legacy transcript
   import: a missing/incomplete v2 projection is not automatically an empty
   thread. Reconcile the importer ledger's DB-path target identity and checkpoints
   as a distinct migration, using event/projected state available after native
   compaction. Ambiguity becomes a per-task conflict; never match on title alone.
5. Adopt T3 built-in imports only after deriving the deterministic built-in ID,
   checking project/provider/source identity, normalizing and comparing all
   supported message text/history, and then adding metadata for t3-import-owned
   sync/replacement. Native built-in imports omit data t3-import can represent,
   so a reduced transcript should be a conflict rather than “exact”.
6. Make source discovery and each selected import/sync/replace return structured
   per-session outcomes. Current batch source loads can reject the whole batch,
   and existing item results do not include source/discovery failures; this
   needs changes across discovery and result aggregation, not just a new target
   writer. See local [`src/cli.ts`](../src/cli.ts),
   [`src/sources/claude.ts`](../src/sources/claude.ts), and
   [`src/sources/codex.ts`](../src/sources/codex.ts).

### Packaging options and tradeoffs

| Approach | Benefit | Main cost or limitation |
|---|---|---|
| Pin and vendor a minimal source-derived EventSink adapter plus its required T3 contracts/projector dependencies | Works offline with T3 closed; preserves projection atomicity; fits current importer workflow | Must package runtime dependencies and keep source notices; private workspace modules need vendoring/build output; every target update needs conformance work |
| Build an isolated helper from the exact T3 source checkout during development/release | Tests against native source and can emit a standalone helper | Build chain is heavier and pinned build artifacts must be shipped or rebuilt; source tree may pull a broad dependency graph |
| Call T3's websocket importer | Reuses T3's running native server | Requires a live server and only supports its scanner's text import; misses agreed features and conflicts with closed-T3 safety model |
| Implement SQL projection logic independently | Avoids Effect runtime/package internals | Duplicates a projector T3 explicitly keeps authoritative; transaction/sequence/idempotence bugs can silently corrupt UI state; not recommended |

Recommended next engineering proof: make the smallest pinned compatibility
helper and run it against a synthetic v2 database in a temp directory. Use the
real T3 migrations and EventSink, insert one synthetic thread with one user
message, stop the helper, reopen using T3's read/projector layers, and assert
that the thread, event sequence, projection metadata, and transcript all agree.
Native append uses plain inserts, not duplicate-event upserts; see the pinned
[`appendAgentEvents` implementation](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/persistence/OrchestrationEventStore.ts#L437-L481).
Repeat the same source import through the adapter to prove its duplicate detection
produces a no-op, and separately verify that a duplicate native insert fails
atomically. Simulate a failure between asset staging and DB commit.
This is not yet run: the current compatibility
harness hardcodes the v1 projection API, and the pinned T3 internal Effect and
workspace dependencies are not part of t3-import's published package.

## Acceptance proof plan

| Boundary | Evidence required | What it does not establish |
|---|---|---|
| Pinned storage/writer synthetic test | Run migrations in isolated temp homes; write with EventSink; decode through T3 schema/projector; assert projection visibility, sequence metadata, append idempotence, backup/rollback, and assets | Desktop rendering or real providers |
| Source adapters and ledger | Codex and Claude fixtures cover fresh/repeated import, settled/interrupted/failed turns, supported images/plans/activity, sync after continuation, edits/deletions, replacement, matching v1-upgrade targets, missing-ledger recovery, and built-in adoption/conflict | Real provider routing or actual UI display |
| CLI and TUI outcomes | Preview target path; explicit override; invalid v2 refusal without fallback; structured per-session already-imported/limit/conflict/failure/next action; partial batches continue | T3 projection correctness beyond checked fixture |
| Isolated desktop | Import representative fixtures into a cloned/test T3 home; inspect visible messages, images, plans/activity and replacement ownership; confirm no normal user data is involved | Provider execution |
| Real provider continuation | Minimal disposable Codex and Claude sessions, isolated T3 home; continue same native session and sync afterward without duplicate turns | Broad provider compatibility beyond the tested exact nightly/provider versions |
| Legacy regression | Re-run current 40–53 compatibility scenarios and existing package checks | Unknown future T3 versions |

The separate per-session diagnostic requirement spans discovery as well as target
writes: malformed/unreadable source files can be skipped before an importer item
exists, while a source-read rejection currently aborts a selected batch. The test
matrix should include each of those routes.

## Unresolved questions for implementation/design review

- Which packaging route will carry the pinned native EventSink and its internal
  dependencies into the published CLI without relying on an installed T3 source
  checkout?
- What is the exact, user-safe contract when a v1-imported task is present in
  `statev2.sqlite` but the original provider session is no longer readable?
  History adoption and sync can be separate from provider continuation; do we
  allow safe history sync while labeling continuation unavailable?
- Can the T3 `EventSinkV2` `write` path be invoked independently with only
  storage layers, or does product integration need more server/runtime services
  for the selected events? Confirm with the synthetic helper before committing
  to the narrow dependency graph.
- Which v2 cache paths should be reset or left untouched? T3's v2 profile has
  separate browser profile/cache behavior; existing t3-import cache profiles
  were designed for the legacy target. Inspect the exact profile code before
  changing it.
- How should interrupted writes recover if the SQLite transaction commits but
  the external asset rename or ledger checkpoint does not? Tests must prove
  retry behavior for each ordering.
- What schema fingerprint is the minimum safe validator when a user may run a
  different nightly against a database created by this target? Migration number
  alone cannot identify the binary commit.

## Research limits

Source-only review of the pinned T3 commit and the local importer/spec. The full
T3 source archive was downloaded and extracted under the repository's ignored
`artifacts/t3-reference` directory for inspection; only the report is intended
as a tracked research deliverable. No automated test or source code was executed
against a synthetic home. No installed T3 database or cache was read or changed.
No real Codex or Claude provider request was made. The existing compatibility
harness and local importer constraints should be rechecked during implementation
before choosing the final module boundary.
