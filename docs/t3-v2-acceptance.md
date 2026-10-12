# T3 v2 acceptance index

This is the current entry point for T3 v2 validation. The implementation is pinned to T3 Code `0.0.46-nightly.20261011.2994`, source commit `d07a07f33c0a1b317dea6234636976231c3688b5`, migration 61. The native helper source archive SHA-256 is `adb3a2523804bb9a017b04fb12af9e6da8d81d58c10d830240a6b4db71e11bf8`; the desktop acceptance report records the tested AppImage hash.

## Current checks

Run the reproducible pinned checks and build the isolated synthetic Codex and Claude fixtures with:

```sh
npm run acceptance:v2 -- --appimage /path/to/T3-Code-0.0.46-nightly.20261011.2994-x86_64.AppImage
```

The AppImage path is optional for automated checks, but required to enable GUI acceptance completion. The runner verifies its SHA-256 against the pinned evidence. It owns fixture setup, isolation, check execution, and output format. Its versioned manifest is written by default to `artifacts/v2-native/acceptance/<UTC timestamp>/manifest.json`; each check records its command, status, summary, and output file. Artifacts under `artifacts/` are local generated output and are gitignored. Raw logs can contain local process details, so keep them private; share the manifest and selected sanitized results or screenshots rather than the whole artifact directory.

For the GUI phase, use the generated `GUI_CHECKLIST.md` and fixture manifest with an isolated Agent Workspace. Inspect both imported tasks and save screenshots under that run's `screenshots/` directory. Then run the checklist's post-view command to exercise replacement and repeated sync, close the apps, and stop the workspace. Record completion with:

```sh
npm run acceptance:v2:complete-gui -- \
  --manifest artifacts/v2-native/acceptance/<run>/manifest.json \
  --codex-screenshot screenshots/codex.png \
  --claude-screenshot screenshots/claude.png \
  --workspace-stopped --apps-closed
```

This command verifies the screenshots and post-view results before updating the manifest to `accepted`. The script never launches the desktop or workspace, so automated success alone leaves GUI status pending. `npm run test:v2-acceptance-runner` runs the runner's isolation, output safety, and serialization regression tests.

The cross-platform GitHub Actions matrix runs `npm run typecheck`, `npm test`, and `npm pack` on Windows, macOS, and Ubuntu with Node 22 and 24. A separate Linux x64 Node 22 job runs `npm run test:v2-pinned`, which prepares the verified pinned source and migration fixtures, requires the targeted v2 suites, and checks the packed consumer. A plain `npm test` can skip fixture-dependent tests when their fixture environment is absent. The legacy matrix is reproduced with `npm run test:compatibility`.

## Latest verification — 2026-10-12

The fresh local acceptance run is **accepted** on tested repository HEAD `3f86bf5`. Its [manifest](../artifacts/v2-native/acceptance/2026-10-12T07-31-28-315Z/manifest.json) records the verified pinned AppImage checksum, runner-safety checks, 154/154 required pinned-v2 tests, packed consumer/package check, and synthetic fixture setup. The tested repository snapshot is recorded in [run context](../artifacts/v2-native/acceptance/2026-10-12T07-31-28-315Z/gui/run-context.json). The earlier 640/640 fixture-enabled suite and typecheck remain the latest full-suite and typecheck results; no implementation code changed between those checks and this fresh acceptance run.

Manual GUI checks in an isolated Agent Workspace showed both synthetic Codex and Claude histories with their text, image previews, plans, and tool activity. After viewing both original tasks, replacement succeeded for each provider; each then synced twice with `up-to-date` status and zero new events. Reopening the pinned app showed both replacement histories, and the workspace record confirms the apps were closed and the workspace stopped. Initial and replacement screenshots are in the run's [screenshots directory](../artifacts/v2-native/acceptance/2026-10-12T07-31-28-315Z/screenshots/); [post-view results](../artifacts/v2-native/acceptance/2026-10-12T07-31-28-315Z/gui/after-view-results.json) record the replacement and repeat-sync outcomes.

## Current boundaries

- Compatibility is established for the pinned `.2994` source only. No future nightly compatibility is claimed.
- Built-in history adoption requires a complete supported source-history match. The actual T3 wizard imports of the tested sessions omit usage/activity and include additional Codex handoff/prelude records, so those cases correctly remain conflicts.
- Automated fixture, package, and compatibility checks do not establish desktop rendering. Codex and Claude GUI checks were manual on isolated workspaces; their dated evidence and screenshots are described in the [acceptance report](t3-v2-real-provider-acceptance.md).
- The historical 638-test count and 54-scenario result are dated results in that report, not a live status assertion. Use a fresh runner manifest and current CI result for a new acceptance decision.

## References

- [Real-provider, GUI, and final-retake evidence](t3-v2-real-provider-acceptance.md)
- [Pinned helper packaging and source-lock procedure](../scripts/compatibility/v2-native/README.md)
- [Original `.2980` design baseline](t3-v2-native-design.md)
- [Historical workflow readiness assessment](t3-v2-workflow-readiness.md)
