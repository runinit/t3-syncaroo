# T3 nightly v2 support

Scope decisions and final shared understanding confirmed on 2026-10-11. The
implementation specification is in [t3-v2-support-spec.md](t3-v2-support-spec.md).
The native write strategy still requires implementation validation.
Pinned source findings and the proposed proof are in
[t3-v2-support-research.md](t3-v2-support-research.md).

## Agreed scope

- Approved target T3 Code `0.0.46-nightly.20261011.2994`, source commit
  `d07a07f33c0a1b317dea6234636976231c3688b5`. The earlier `.2980` proof and
  installed-profile investigation remain historical evidence, not `.2994`
  runtime or GUI acceptance.
- Preserve the current feature set for both Codex and Claude Code: history import,
  eligible session continuation, synchronization, replacement, attachments, and
  backup/recovery protections.
- Retain support and existing behavior for T3 database migrations 40–53.
- Implement in working slices; partial functionality does not constitute full
  support for the target nightly.
- Recognize tasks imported before a T3 upgrade and preserve their source mapping
  for synchronization and replacement without duplicate tasks or mandatory
  reimport.
- Verify with automated compatibility tests using the pinned T3 code and an
  isolated desktop check of visible history, attachments, and replacement.
- Include minimal real Codex and Claude Code continuation checks using disposable
  source sessions and an isolated T3 home. The user authorized configured provider
  account usage for these checks; normal conversations remain untouched.
- Report ambiguous pre-upgrade task mappings as actionable per-task conflicts;
  allow unrelated valid tasks to proceed. Never guess mappings or silently create
  duplicate imports as recovery.
- When both databases exist, prefer a validated `statev2.sqlite` and show the
  selected target before writing. Retain `--db` for explicit selection. An invalid
  or unsupported v2 database stops automatic selection instead of falling back to
  legacy storage.
- Adopt tasks created by T3's built-in session importer when source identity and
  history match exactly; enable synchronization and replacement without duplicate
  tasks. Report ambiguous or divergent matches as conflicts.
- Explain every skipped source session with a reason and recovery action.
  Distinguish already imported sessions, limit deferrals, history conflicts, and
  actual failures in interactive and scriptable results.

## Questions under investigation

- How does this release select and initialize its v2 database?
- Can its legacy conversion path support initial imports and later synchronization,
  or are native v2 events required?
- What provider bindings enable continuation of an imported source session?
- How are existing importer identities preserved when T3 converts imported tasks?

## Evidence

- The [exact release](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261011.2980)
  identifies source commit `ed0f7b908b2e`.
- Its [thread migration guide](https://github.com/pingdotgg/t3code/blob/v0.0.46-nightly.20261011.2980/docs/user/thread-migration.md)
  describes a one-time copy from `state.sqlite` to `statev2.sqlite`, followed by
  independent databases. Legacy migration preserves selected history and metadata,
  but does not retain the old live provider session; continuation starts a fresh
  session. This is insufficient by itself for the agreed importer feature parity.
- The importer keys its ledger target by database path and stores legacy event
  checkpoints. Recognizing pre-upgrade imports therefore requires explicit ledger
  reconciliation as well as matching T3 task identities.
- The pinned [v2 event store](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e/apps/server/src/orchestration-v2/EventStore.ts)
  delegates to the shared orchestration event store. Active v2 thread events use
  `orchestration_events` with `application_event_version = 2`; the mere presence
  of `orchestration_v2_events` does not identify the active event table.
- The pinned [built-in agent session importer](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e/apps/server/src/project/AgentSessionImporter.ts)
  imports Codex/Claude transcripts, sets an active provider thread with a strong
  native session reference, and stores a stopped provider runtime with a resume
  cursor. It is a reference for native import and continuation, and introduces
  possible collisions with tasks this release has already imported itself.
- The built-in importer is wired to the welcome wizard's Projects step, titled
  "Import your projects". The pinned [welcome route](https://github.com/pingdotgg/t3code/blob/ed0f7b908b2e/apps/web/src/routes/welcome.tsx)
  explicitly permits reopening setup at `/welcome`. Automatic first-run routing
  skips existing workspaces or completed onboarding; no regular settings/menu
  entry was found in the pinned web client.

## Acceptance scenarios

- Both providers import representative messages, terminal turn states, plans,
  supported images, and compacted activity; the isolated T3 desktop displays them.
- Repeated import and synchronization do not duplicate history. Matching turns
  created through T3 are adopted; changed history produces an actionable conflict.
- Replacement retires the old task and makes the new task the sole synchronization
  and eligible session-continuation target, including in the desktop view.
- A pre-upgrade imported task is recognized in v2 without reimport; ambiguous
  mappings conflict without preventing unrelated valid tasks from proceeding.
- Exactly matching built-in imports can be adopted; divergent ones conflict.
- Source-session continuation succeeds for both real providers using disposable
  sessions in an isolated T3 home, alongside controlled automated adapter checks.
- Automatic database selection chooses validated v2 storage, reports its target,
  and stops on an invalid or unsupported v2 database; explicit `--db` still works.
- Existing migration 40–53 compatibility scenarios remain passing.
- Every skipped session has a distinguishable outcome and recovery guidance.

## Implementation questions to validate

- Source research found no normal startup replay of externally appended v2 events.
  Validate a pinned native event-sink integration and its distribution strategy
  before changing the importer's projection-write boundary.
- How native provider references and conversation heads preserve Claude branch
  continuation and Codex continuation across imports and replacements.
- How to reconcile ledger checkpoints against converted legacy tasks without
  overwriting history added through T3.
- How v2 event compaction affects ledger recovery and duplicate detection.

Any discovered limitation that changes the agreed behavior must return to the
design discussion rather than silently narrow the scope.

## Observed built-in import result

On 2026-10-11 the user ran the built-in wizard: it reported 121 imported threads
and 206 threads that could not be imported. Existing server traces record one
`AgentSessionThreadProjectConflictError`: a source session's deterministic import
ID already belonged to a different project. The other skips have not been
reproduced or individually diagnosed.

The pinned scanner returns generic `Skipped` outcomes for budget exhaustion,
unreadable/changing files, workspace mismatches, and unsupported parsed history.
Its importer counts these alongside write conflicts, and the wizard displays the
combined count without per-thread reasons. Thus the toast alone cannot distinguish
these cases or establish that the 206 source sessions are corrupt.

Implementation validation will resolve the remaining technical questions. This
document does not authorize writes to installed T3 data.
