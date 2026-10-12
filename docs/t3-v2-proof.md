# Native T3 v2 write proof

Run date: 2026-10-11. Target T3 Code source commit:
[`ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e`](https://github.com/pingdotgg/t3code/tree/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e),
the source pinned for `0.0.46-nightly.20261011.2980`.

Historical proof for `.2980` only. The approved implementation target is now
`.2994`; this result does not establish `.2994` runtime acceptance.

## Result

**Pass for the native persistence boundary.** The proof opened a marked synthetic
home and a fresh `statev2.sqlite`, applied the pinned T3 migrations through 61,
and used the actual `EventSinkV2` implementation to write one imported thread,
one message, a user turn item, and a Codex provider-thread binding. The sink wrote
the event log, native projections, turn-item positions, and projection metadata
through T3's own transaction boundary.

The database client then closed. On a new connection, the pinned T3
`ProjectionStoreV2` read the thread and message and returned the provider
thread's strong native session reference. T3's `EventStoreV2` read all four
events with application event version 2, and projection metadata was at schema
version 2 and sequence 4.

The proof also exercised a synthetic same-ID/no-write preflight against T3's
projection: the thread ID was already present, so the helper reported
`already-present` and wrote no second thread. It does not call T3's full
`AgentSessionImporter` or verify its project, history-origin, and source
metadata guards. Finally, a batch appended a new message before attempting an
event with an already-used event ID. The batch failed; after reopen, the
message count and event stream still contained only the original message. This
demonstrates rollback across both event and projection writes.

The persisted project row is seeded through T3's actual `ProjectStoreV2` in the
synthetic home. No application/server is started. The proof establishes durable
native writes and reads across a database close/reopen; it does not claim normal
server startup replays events, because the pinned source review found no such
startup replay. It also does not establish desktop rendering, attachment bytes,
provider continuation, sync/replacement behavior, or cache handling.

## Reproduce

The reference source archive is expected at
`artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e`,
as used by this workspace. The source archive omits the repository patch files
and one local mobile tarball required by pnpm's workspace resolver. Preparation
fetches those exact files from the pinned commit, installs only
`@t3tools/shared` and its contracts dependency, and keeps the generated
dependencies under ignored `artifacts/` paths:

```sh
node scripts/compatibility/v2-proof/prepare.mjs
node --experimental-strip-types scripts/compatibility/v2-proof/run.mjs
```

The second command creates a new directory named
`artifacts/v2-proof/synthetic-home-*`. Each home has a marker file and its own
`statev2.sqlite`; no installed T3 database or cache is opened. The runner uses
the pinned Effect dependency installed by preparation, avoiding multiple
incompatible Effect module instances.

Observed run result: `PASS`; migrations 1–61 completed; imported event sequence
1–4 with application event marker 2; close/reopen read succeeded; same-ID
preflight wrote zero events; duplicate-key transaction failure rolled back the
new event and projection. Node version was `v26.11.1`, pnpm was `11.10.0`.

## Distribution and licensing evidence

The T3 repository's pinned [LICENSE](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/LICENSE)
is MIT, with copyright notice `T3 Tools Inc., 2026`; redistributed substantial
T3 source therefore needs that notice. The pinned `@t3tools/contracts`
package is marked `private: true` and exports workspace TypeScript source, so it
is not a published package API. Its privacy flag does not replace the
repository's MIT license, but it means t3-import would need to bundle or vendor
the necessary contracts and preserve notices rather than depend on a public
T3 package.

The main native sink/projector modules and their immediate persistence helpers
total about 444 KB of TypeScript source before contracts and transitive modules.
The proof's filtered install still added 284 packages and used about 557 MB in
the pnpm virtual store because `@t3tools/shared` declares a broad runtime
dependency set. This is an install footprint, not a measured minimal bundle or
publishable runtime size. The proof used the native Node SQLite client and
Effect `4.0.2` as patched in the pinned workspace. A release approach still
needs to establish a narrow bundle boundary, include third-party license
notices, and measure the production artifact. The proof does not establish that
the full monorepo package graph should ship with t3-import.

## Artifacts

- Reproducible runner: [`run.mjs`](../scripts/compatibility/v2-proof/run.mjs)
- Dependency/source preparation: [`prepare.mjs`](../scripts/compatibility/v2-proof/prepare.mjs)
- Scope and prior source analysis: [`t3-v2-support-spec.md`](t3-v2-support-spec.md),
  [`t3-v2-support-research.md`](t3-v2-support-research.md)
