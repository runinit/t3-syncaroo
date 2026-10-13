# Historical T3 v2 acceptance record

This record documents acceptance work on the former TypeScript implementation.
Its runner, native helper, fixtures, and artifacts are not part of the Go v1.0
release. The results below are historical context, not acceptance evidence for
the Go port. Current build and test commands are in the root README.

## Go port verification boundary

The Go test suite covers the pinned v2 profile using synthetic SQLite homes.
Service tests exercise import, synchronization, replacement, built-in and
native-history adoption, checkpoint recovery, conflict refusal, and backup or
cache behavior. The v2 package tests exercise event and projection writes,
readback, rollback, and strict profile validation. These tests do not run T3's
pinned migration runner or real provider sessions. The legacy adapter has
separate tests against captured T3 DDL for each migration 40–53; see
[compatibility evidence](compatibility.md).

The Go CLI has also been smoke-tested against a database created by the pinned
T3 application itself. That runtime check is recorded below; it validates T3's
event projection and storage behavior but does not establish desktop rendering
or real-provider continuation. The TypeScript-era GUI screenshots and provider
results below are historical and cannot be used as evidence for the Go release.

The former implementation targeted T3 Code `0.0.46-nightly.20261011.2994`, source commit `d07a07f33c0a1b317dea6234636976231c3688b5`, migration 61. The native helper source archive SHA-256 was `adb3a2523804bb9a017b04fb12af9e6da8d81d58c10d830240a6b4db71e11bf8`; the desktop acceptance report records the tested AppImage hash.

## Former acceptance process

The former process used a pinned T3 Code nightly, synthetic Codex and Claude
fixtures, a bundled native helper, and isolated GUI checks. The runner and helper
were removed during the Go port, so those npm commands are intentionally not
available in this checkout. The date-stamped findings below describe the earlier
implementation only.

## Go pinned T3 runtime smoke — 2026-10-13

The run used T3 Code `0.0.46-nightly.20261011.2994`, AppImage SHA-256
`e8c01c767c16cbeb9181dc04f4f1bbc88553b12b746c17f4e9189f266bf036e7`, with a
fresh disposable T3 home. The app created its migration-61 database; the Go
CLI then imported synthetic Codex and Claude transcripts, each with two settled
turns. No provider API was called.

On successive app starts, T3 projected both imports and syncs. Each source
preview returned `up-to-date` after synchronization. Editing the first answer
in each synthetic transcript made both histories replaceable; Go replacement
created a new thread and tombstoned the old one for each provider. The final T3
projection contained four thread rows, two live threads, and 16 messages;
SQLite integrity was `ok`. The `sqlite_master` schema and all 61 migration
records had identical fingerprints before importer writes and after T3
reprojected the replacements.

This was a backend/runtime smoke in a private Xvfb display. No application
window rendered there, so it does not count as desktop acceptance. The temporary
T3 home, provider fixtures, and backups were not added to the repository.

## Historical TypeScript acceptance — 2026-10-12

The former TypeScript implementation's acceptance work is summarized in the
[historical provider and GUI report](t3-v2-real-provider-acceptance.md). Its
runner manifests and screenshots are not included in this Go-only checkout;
that acceptance is not evidence for the Go port.

## Current boundaries

- Compatibility is established for the pinned `.2994` source only. No future nightly compatibility is claimed.
- Built-in history adoption requires a complete supported source-history match. The actual T3 wizard imports of the tested sessions omit usage/activity and include additional Codex handoff/prelude records, so those cases correctly remain conflicts.
- Automated fixture, package, and compatibility checks do not establish desktop rendering. Codex and Claude GUI checks were manual on isolated workspaces; their dated evidence and screenshots are described in the [acceptance report](t3-v2-real-provider-acceptance.md).
- The historical 638-test count and 54-scenario result are dated results in that report, not a live status assertion. Use a fresh runner manifest and current CI result for a new acceptance decision.

## References

- [Real-provider, GUI, and final-retake evidence](t3-v2-real-provider-acceptance.md)
- Historical helper packaging and source-lock procedure (the helper is no longer shipped)
- [Original `.2980` design baseline](t3-v2-native-design.md)
- [Historical workflow readiness assessment](t3-v2-workflow-readiness.md)
