# Pinned T3 v2 native helper packaging proof

This is a bounded packaging experiment for T3 Code source commit
`ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e`. It demonstrates the native
EventSinkV2 persistence seam from an npm-packed, unpacked candidate helper. It
does not integrate the helper into t3-import's production package or CLI.

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

An existing thread ID returns `existing-thread-conflict` with the current
native shell. The helper does not treat an ID match as proof of source/history
identity or authorize skipping the import; the caller must validate those
attributes before choosing recovery behavior. Before any writes, the helper
also checks the `thread.created` ID and project against the event envelope,
checks event payload thread IDs, and restricts the optional project command to
a new `project.create` / `project.created` pair. Project preflight includes
deleted rows so a tombstoned project ID is not reused.

The stdin protocol acceptance test runs against the unpacked candidate. It
writes and reads back a representative thread, message, turn item, and native
provider-thread binding; verifies existing-thread conflict and identity
rejections, plus close/reopen; then installs a test-only SQLite trigger that aborts a projection
write to prove the thread event batch rolls back and project compensation marks
the project deleted. The trigger is fault injection only; persistence and
projections use the pinned T3 implementation.

Most recent candidate: 2,993,567 bytes unpacked and 576,094-byte npm tarball,
115 pinned T3 source files, and 94 bundled dependencies. All 94 have nonempty
license texts (92 MIT, 1 ISC, 1 BSD-2-Clause); the helper's external runtime
imports are Node built-ins only. The migration runner is separate from the
candidate helper. The packed-consumer positional and stdin protocol tests pass
on Node 22.16.0 and Node 26.11.1. The repository's real `npm pack` path and its
final installed dependency graph have not been tested. This proof is not
sufficient by itself to claim product support.
