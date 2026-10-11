# 01: Import a settled Codex conversation into v2

**What to build:** A user can safely select the validated T3 v2 database and import a settled Codex text conversation that T3 can read and continue after restart. The published CLI includes the pinned native writer without requiring a T3 checkout at runtime.

**Blocked by:** None (can start immediately).

**References:** [Support spec](../../../docs/t3-v2-support-spec.md) · [Research](../../../docs/t3-v2-support-research.md) · [Design](../../../docs/t3-v2-native-design.md) · [Completed writer proof](../../../docs/t3-v2-proof.md) (evidence, not a ticket).

**Status:** done

- [x] With T3 closed, the importer previews the selected path, defaults to validated `statev2.sqlite` when present, honors explicit `--db`, and refuses invalid or unsupported v2 without falling back to `state.sqlite`.
- [x] The packed CLI writes a text conversation and strong Codex provider-session binding through the pinned native sink; T3 reads the task after reopening the database.
- [x] Before writing, the importer checks integrity and runtime/projection safety, makes and verifies a backup, and applies the validated v2 cache and startup event-budget rules.
- [x] Dry run performs no writes; retries do not duplicate tasks; write failures roll back events and projections, retain the verified backup, and clean up only staged files from that attempt.
- [x] v2 operations enforce the pinned SQLite runtime requirement; legacy migrations 40–53 behavior and declared Node.js support remain intact.
- [x] A clean packed consumer can run the helper without a T3 checkout or development dependency store, and bundled T3 license notices are included.
