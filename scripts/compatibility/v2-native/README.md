# Pinned T3 v2 native helper packaging proof

This is a bounded packaging experiment for T3 Code source commit
`d07a07f33c0a1b317dea6234636976231c3688b5`. The generated helper is vendored
and used by t3-import's nightly-v2 import, synchronization, and replacement
paths. It demonstrates the native EventSinkV2 persistence seam from an
npm-packed, unpacked helper.

## Reproduce

From the repository root, prepare the pinned source checkout and dependencies,
then build and run the proof. The two small lock-gate checks can be run with:

```sh
node scripts/compatibility/v2-proof/prepare.mjs
node scripts/compatibility/v2-native/build.mjs
node scripts/compatibility/v2-native/license-gate.test.mjs
node scripts/compatibility/v2-native/source-lock-gate.test.mjs
```

Preparation downloads the pinned source material and installs the filtered T3
workspace dependency graph. The build verifies the pinned T3 release archive,
pnpm lockfile, every traced T3 source file, the exact traced source-file sets for both bundles, and the exact esbuild/npm tarball
integrities in `source-lock.json` and `build-tool-lock.json`. This build-tool
lock currently covers Linux x64 only. The build emits a fixture-only migration
runner and candidate helper under ignored `artifacts/v2-native/`, creates an
npm tarball, extracts it into a fresh consumer folder, migrates a synthetic
database with the fixture runner, then runs the packed helper with `NODE_PATH`
empty. The helper has no runtime npm dependencies; its traced runtime externals
are Node built-ins, including `node:sqlite`.

`LICENSES.md` and `vendor-manifest.json` are generated alongside this source.
The manifest records the pinned source and lockfile hashes, helper hash, traced
T3 source files, each dependency's exact pnpm-lock integrity, license metadata,
and hashes of included license files. The notice file includes the T3 MIT
license and every actual license text file found in the traced dependency
packages. The build fails if a package has no version, declared license,
matching pinned package integrity, or nonempty license text.

## Evidence and limits

The unpacked helper preserves its positional no-input self-test and accepts one
JSON request on stdin. `inspect` reads integrity, migration/profile metadata,
and optional thread projections without migration. `write` decodes supplied
events with the pinned contracts, preflights thread and event IDs, commits an
optional new project using `EventSinkV2.commitProjectCommand`, writes exactly
one thread through `EventSinkV2.write`, then opens a new read-only layer and
returns native projections. Project commit and thread batch are separate native
transactions. If the thread batch fails after a new project was committed, the
helper attempts deterministic `project.deleted` compensation through
`commitProjectCommand` and reports both `projectCommitted` and
`projectCompensated`; failed compensation remains a partial commit for caller
recovery.

The helper also accepts an `append` request for an existing imported thread.
It requires the expected thread/project/provider IDs, active provider-thread
ID, nullable-or-strong native source reference, and exact expected nullable-or-
strong conversation-head reference. It reads the current shell and provider
binding through T3's projection store, rejects missing, deleted, ambiguous, or
mismatched bindings, and rejects any event IDs already in the native event
store. Append batches are limited to `message.updated`, `turn-item.updated`,
`plan.updated`, and at most one matching `provider-thread.updated`; create,
delete, and project events are forbidden. A null `nativeThreadRef` is allowed
only when the current active binding also has no native reference, preserving
history-only imports that opted out of resume. A supplied provider-thread
update must keep that reference and may advance its conversation head only to
a strong reference or null; a null source reference cannot gain a conversation
head during append.

Head, binding, and event-ID checks run inside the same writable SQLite
transaction as `EventSinkV2.write`. The pinned client begins that transaction
with `BEGIN IMMEDIATE`; the native sink uses a nested savepoint on the same
connection. A competing database writer therefore cannot change the checked
identity/head between preflight and the append. The application must still keep
T3 closed and hold the importer lock while appending, because this helper does
not coordinate with provider activity or the running application's lock. After
the transaction commits, the helper opens a new read-only layer and returns its
stored sequence range and projections. A preflight mismatch or event-ID
collision returns a structured conflict without writing. Sink failures are
returned as `write-failed`; the native sink rolls back the event batch.
If SQLite rejects the transaction because a competing writer holds the lock,
the helper returns an `append-conflict` with reason `database-busy`; the caller
can retry after the writer finishes.

The outer transaction relies on this helper's one-shot composition: its
`EventSinkV2.write` has no effects, and the helper constructs no event stream
subscribers or outbox workers. EventSink's nested call publishes to
process-local PubSubs before the outer transaction commits, but no service in
this child subscribes to them and the child exits after returning its response.
This ordering is safe only for this isolated helper. Do not move the outer
transaction around `EventSinkV2.write` in a running T3/server composition; there,
listeners could observe a publication before the outer commit.

An existing thread ID returns `existing-thread-conflict` with the current
native shell. The helper does not treat an ID match as proof of source/history
identity or authorize skipping the import; the caller must validate those
attributes before choosing recovery behavior. Before any writes, the helper
also checks the `thread.created` ID and project against the event envelope,
checks event payload thread IDs, and restricts the optional project command to
a new `project.create` / `project.created` pair. Project preflight includes
deleted rows so a tombstoned project ID is not reused.

The `replace` operation atomically creates one complete replacement thread and
tombstones every verified old thread in one `EventSinkV2.write` batch. It
preflights exact old project/provider/binding identities, idle orchestration
state, runtime ownership, event IDs, and globally unique T3-local provider
thread IDs inside the same immediate transaction. A replacement retry succeeds
only when the committed replacement events and retired-thread tombstones match
the request. Each old tombstone must preserve the current persisted thread
payload, allowing only deletion time, update time, and clearing title
regeneration.

The distinct `attach-upgraded-binding` operation attaches one source-derived
provider binding to a live, unbound `v1_import` shell. It requires the caller's
full inspected shell/history snapshot, empty provider-thread/turn records, and
an unchanged snapshot inside the immediate transaction. It appends only one
`provider-thread.updated` event and returns a structured idempotent retry
result. It never infers provider IDs from conversation text.

The stdin protocol acceptance test runs against the unpacked candidate. It
writes and reads back a representative thread, message, turn item, and native
provider-thread binding; verifies exact event ID/sequence ownership and
existing-thread conflict, then appends a message and matching provider-thread
head update. It tests project/provider/source/head conflicts, forbidden delete
events, event-ID collisions, no-resume append with null source references, and
append rollback under a test-only SQLite projection trigger. A competing-writer
case races two append requests from the same head and requires one append plus
one structured contention conflict, with no failed or partial batch. It also tests project
compensation for failed initial writes and verifies deleted-project
non-resurrection. Replacement cases verify atomic create/tombstone batches,
retries, foreign provider envelopes, and altered title/model/branch/lineage
payloads. Binding-attach cases verify history snapshot CAS, retry, and global
provider-thread-ID collision handling. The trigger is fault injection only;
persistence and projections use the pinned T3 implementation.

Most recent candidate: 3,027,789 bytes unpacked and 581,034-byte npm tarball,
115 pinned T3 source files, and 93 bundled dependencies. All 93 have nonempty
license texts (91 MIT, 1 ISC, 1 BSD-2-Clause); the helper's external runtime
imports are Node built-ins only. The migration runner is separate from the
candidate helper. The packed candidate's stdin protocol passes on Node 22.16.0
and Node 26.11.1. The clean npm-packed consumer passes on Node 26.11.1. Running
the CLI consumer on Node 22.16.0 currently requires a Node-22-built
`better-sqlite3` native addon; reusing the Node-26 addon fails its ABI check.
