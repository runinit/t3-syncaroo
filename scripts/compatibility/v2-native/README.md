# Pinned T3 v2 native helper packaging proof

This is a bounded packaging experiment for T3 Code source commit
`ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e`. It demonstrates the native
EventSinkV2 persistence seam from an npm-packed, unpacked candidate helper. It
does not integrate the helper into t3-import's production package or CLI.

## Reproduce

From the repository root, prepare the pinned source checkout and dependencies,
then build and run the proof:

```sh
node scripts/compatibility/v2-proof/prepare.mjs
node scripts/compatibility/v2-native/build.mjs
```

Preparation downloads the pinned source material and installs the filtered T3
workspace dependency graph. The build uses esbuild 0.25.12, emits a
fixture-only migration runner and the candidate helper under ignored
`artifacts/v2-native/`, creates an npm tarball, extracts it to a fresh consumer
folder, migrates a synthetic database with the fixture runner, then runs the
packed helper with `NODE_PATH` empty. The helper has no runtime npm dependencies;
its traced runtime externals are Node built-ins, including `node:sqlite`.

`LICENSES.md` and `vendor-manifest.json` are generated alongside this source.
The manifest records the pinned source commit, the downloaded release archive
SHA-256, bundled helper SHA-256, traced pinned T3 source files, dependency
versions and license identifiers. The included third-party notices contain the
license texts found in the traced dependency closure.

## Evidence and limits

The unpacked helper uses T3's actual migrations only in the test fixture bundle,
then uses the pinned T3 EventSinkV2, EventStore, ProjectionStore, ProjectStore,
contracts, and Node SQLite client to write and read a representative thread,
message, and native provider-thread binding. It closes and reopens the database,
checks application event version 2, verifies a synthetic existing-ID preflight,
and injects a duplicate event ID to prove the sink transaction rolls back the
whole batch.

Most recent candidate: 2,854,038 bytes unpacked, 563,719-byte npm tarball,
115 pinned T3 source files, and 94 bundled dependencies (92 MIT, 1 ISC, 1
BSD-2-Clause). The migration runner is separate from the candidate helper.
Execution passed with Node 26.11.1. The repository's real `npm pack` path and
its final installed dependency graph were not tested, nor was the Node 22.16
minimum runtime. This proof is not sufficient by itself to claim product
support.
