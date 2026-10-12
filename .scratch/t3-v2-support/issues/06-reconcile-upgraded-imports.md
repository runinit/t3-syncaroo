# 06: Reconcile tasks carried through a T3 upgrade

**What to build:** Tasks imported before T3's one-time v1-to-v2 conversion remain recognizable for synchronization and replacement when their identity and history can be verified; ambiguous matches are isolated conflicts.

**Blocked by:** 01: Import a settled Codex conversation into v2; 04: Continue and synchronize both providers.

**References:** [Support spec](../../../docs/t3-v2-support-spec.md) · [Research](../../../docs/t3-v2-support-research.md) · [Design](../../../docs/t3-v2-native-design.md) · [Completed writer proof](../../../docs/t3-v2-proof.md) (evidence, not a ticket).

**Status:** in-progress

- [ ] A converted task with intact source mapping is matched by deterministic identity, project ownership, and canonical history, not title alone.
- [ ] A missing importer ledger can be recovered conservatively from v2 projections and source evidence without replaying native events.
- [ ] Reconciliation remains correct after T3 event compaction and does not depend on legacy receipts or complete historical event sequences.
- [ ] On a converted or copied database retaining version-1 events, verify the projection checkpoint against T3 v2 native sequence semantics; distinguish the latest application-version-2 event from the global event maximum and do not assume migration implies later v1 writes.
- [ ] Incomplete, changed, or ambiguous histories return an actionable per-session conflict and do not duplicate or overwrite the existing task.
