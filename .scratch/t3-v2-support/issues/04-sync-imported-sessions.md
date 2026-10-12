# 04: Continue and synchronize both providers

**What to build:** Users can continue eligible imported Codex and Claude tasks through T3, then synchronize newly settled source history without duplicating turns or overwriting edits.

**Blocked by:** 02: Preserve complete Codex history; 03: Import Claude history with branch-aware continuation.

**References:** [Support spec](../../../docs/t3-v2-support-spec.md) · [Research](../../../docs/t3-v2-support-research.md) · [Design](../../../docs/t3-v2-native-design.md) · [Completed writer proof](../../../docs/t3-v2-proof.md) (evidence, not a ticket).

**Status:** done

- [x] T3 continuation targets the original Codex or Claude session and selected branch when its source data remains available; unavailability is reported clearly.
- [x] Synchronization appends only new settled turns and excludes active or indeterminate turns.
- [x] Matching turns already created through T3 are adopted, so repeat synchronization adds no duplicate events or messages.
- [x] Edited or deleted imported history produces a per-session conflict without changing the task; repeat sync on unchanged history is a no-op.
