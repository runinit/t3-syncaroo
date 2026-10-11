# T3 Code nightly v2 compatibility

Scope confirmed by the user on 2026-10-11. Local specification; tracker
publication is pending tracker configuration.
The subsequent [pinned-source research](t3-v2-support-research.md) establishes
that the legacy event-only write strategy does not carry over to normal v2
startup. The native integration and packaging remain to be proven in isolation.

## Problem Statement

The user's installed T3 Code `0.0.46-nightly.20261011.2980` uses v2 storage that
t3-import rejects. Writing to the legacy database would not update the user's
current T3 history. The built-in T3 importer has narrower history support and
reported 121 imported threads and 206 unsuccessful threads without individual
reasons, making recovery difficult.

## Solution

Support this exact nightly with the existing t3-import feature set for Codex and
Claude Code. Select the correct storage, retain eligible source-session
continuation, and keep imported tasks synchronized and replaceable. Preserve
existing supported T3 versions, recognize imports across T3 upgrades, and adopt
matching built-in imports without duplicates. Explain every skipped session.

## User Stories

1. As a Codex user, I want to import local conversations into this nightly, so
   that I can read and continue them in T3.
2. As a Claude Code user, I want the same supported import behavior, so that my
   conversations remain usable in T3.
3. As a user, I want to browse, inspect, filter, and select source sessions, so
   that I control which history is imported.
4. As a user, I want completed, interrupted, and failed turns preserved, so that
   the imported task represents what actually happened.
5. As a user, I want supported images, plans, and compacted activity preserved,
   so that imported history retains the information the importer already supports.
6. As a user, I want eligible imported tasks to continue their original source
   sessions, so that T3 does not silently substitute a fresh conversation.
7. As a user, I want repeated imports to avoid duplicates, so that retries are safe.
8. As a user, I want synchronization to append newly settled turns, so that
   imported tasks stay current without rewriting earlier history.
9. As a user, I want matching turns continued through T3 to be recognized, so
   that later synchronization does not duplicate them.
10. As a user, I want changed history reported as a conflict, so that my edits
    are protected and I can choose a recovery action.
11. As a user, I want replacement to create one complete new canonical task and
    retire the old task, so that synchronization and continuation have one target.
12. As an existing user, I want my pre-upgrade imports recognized in v2, so that
    I do not have to reimport them or create duplicate tasks.
13. As a user of T3's built-in import, I want an exactly matching imported task
    adopted, so that t3-import can synchronize or replace it.
14. As a user, I want ambiguous mappings isolated as per-task conflicts, so that
    unrelated valid tasks can still proceed.
15. As a user, I want the selected database shown before writes, so that I know
    the import will reach the intended T3 installation.
16. As a user, I want explicit database selection retained, so that custom homes
    and supported legacy installations remain usable.
17. As a user, I want verified backups and live-T3 protection retained, so that
    writes preserve existing recovery guarantees.
18. As a user, I want every skipped session to have a reason and recovery action,
    so that a summary count does not leave me guessing.
19. As a CLI user, I want distinguishable machine-readable outcomes and dry runs,
    so that automation can preview and handle partial results correctly.
20. As a user of a previously supported T3 release, I want existing behavior
    preserved, so that this addition does not force an upgrade.

## Implementation Decisions

- Pin the initial v2 compatibility reference to the exact nightly's source commit
  `ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e`. A migration number alone is not
  sufficient evidence of compatibility with other releases.
- Retain the existing legacy compatibility path for migrations 40–53. Add an
  explicit v2 target profile and validate its required contracts and integrity.
- Prefer validated v2 storage when legacy and v2 databases coexist. An invalid
  or unsupported v2 target stops automatic selection; retain explicit database
  overrides and display the selected target before writing.
- Keep source discovery and canonical conversation normalization shared where
  behavior is sufficient. Changes to target encoding must respect the established
  source-session and branch semantics.
- Use the nightly's native event contracts. Its active v2 writer uses the shared
  event store with an application event version marker. The built-in legacy
  converter alone cannot satisfy activity, plan, and continuation requirements.
- Validate the native write strategy before integrating it. In particular,
  determine whether startup reliably projects externally appended native events,
  or whether a pinned native event-sink integration is required. The existing
  no-direct-projection-write behavior remains the baseline; any necessary change
  to that boundary requires a documented design decision before implementation.
- Model continuation through the native provider-thread reference and any runtime
  bindings required by the pinned implementation. A newly opened provider process
  is acceptable; silently starting a different source session is not equivalent.
- Reconcile legacy ledger targets, checkpoints, and task identities explicitly
  across upgrade. Retain source mappings and protect T3-only history. Identity or
  title matching alone does not establish safe adoption.
- Adopt built-in imports only after verifying source identity and history. Reduced
  or divergent histories produce actionable conflicts rather than guessed merges.
- Preserve deterministic repeatability, replacement ownership, missing-ledger
  recovery, and recognition of turns already continued through T3. Account for
  native event compaction when choosing recovery evidence.
- Preserve closed-T3 checks, dry runs, verified backups, atomic writes and asset
  staging, and appropriate cache handling for the selected target profile.
- Report per-session outcomes in the terminal interface and structured output.
  Distinguish already imported, deferred by a limit, history conflict, and failure;
  provide a reason and a concrete next action without exposing secrets.
- Implement in working slices. Partial functionality does not constitute full
  support for this nightly.

## Testing Decisions

The user approved automated compatibility validation, isolated desktop checks,
and minimal real continuation checks for both providers. Test observable behavior
at these boundaries, using the existing compatibility harness as prior art:

1. **Public importer commands and operations:** target selection, preview/dry run,
   import, synchronization, replacement, recovery, and per-session outcomes. These
   checks catch importer behavior and side effects; they do not prove T3 renders
   or accepts the data.
2. **Pinned T3 runtime:** use real migrations, event decoding, projection, and
   provider routing against synthetic homes. Assert the resulting task history
   and bindings using T3 read interfaces where available. Controlled adapters
   check routing without proving actual provider execution.
3. **Isolated T3 desktop and real providers:** verify visible history, images,
   plans/activity, and replacement, then continue disposable Codex and Claude
   sessions with minimal calls. Confirm original source-session identity and
   subsequent synchronization without duplicates. Provider account usage for
   these disposable checks is authorized; normal conversations remain untouched.

Required scenarios include:

- Fresh imports for both providers, including terminal states and supported assets.
- Repeated imports and synchronization, active-turn exclusion, changed-history
  conflicts, and adoption of matching turns created through T3.
- Replacement visibility, sole synchronization ownership, repeatability, and resume.
- Pre-upgrade imports recognized after real T3 conversion, including intact ledger
  and missing-ledger recovery scenarios. Ambiguity must not duplicate tasks.
- Adoption of matching built-in imports and refusal of divergent or incomplete matches.
- Both databases present, explicit target overrides, and invalid/unsupported v2
  targets stopping selection without fallback writes.
- Live-T3 refusal, verified backups, interrupted-write recovery, and asset/cache
  behavior appropriate to the selected profile.
- Per-session diagnostic outcomes, including limits and partial success.
- All existing supported legacy compatibility scenarios, plus relevant unit,
  typechecking, and build checks.

For each new supported behavior, observe the relevant failing check before the
implementation and then verify the behavior through the appropriate boundary.
Record executed checks and any blocked acceptance gates; controlled adapter
success alone cannot substitute for the real-provider checks.

## Out of Scope

- Unvalidated future T3 releases or blanket acceptance of migrations 54–61.
- Changing T3's built-in importer or repairing its upstream UI.
- Guessing ambiguous Claude branches, overwriting divergent history, or silently
  duplicating tasks as recovery.
- Expanding transcript fidelity beyond the importer's established source behavior.
- Resetting the user's v2 database from the legacy database.
- Importing into or modifying the user's normal T3 data during development checks.

## Further Notes

The confirmed scope, observed built-in import result, and primary-source evidence
are retained in the companion design notes. Native write/rebuild behavior, Claude
conversation-head binding, legacy checkpoint reconciliation, and event-compaction
recovery remain proof obligations rather than established implementation facts.
Any limitation that changes the agreed behavior must return to the user for a
scope decision. Tracker publication and ticket creation are separate from this
local specification; no external issue has been created.
