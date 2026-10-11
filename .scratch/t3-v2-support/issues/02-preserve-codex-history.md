# 02: Preserve complete Codex history

**What to build:** Importing a Codex source session preserves the history t3-import already supports, including its structured activity and image attachments, in a form T3 can display and recover safely.

**Blocked by:** 01: Import a settled Codex conversation into v2.

**References:** [Support spec](../../../docs/t3-v2-support-spec.md) · [Research](../../../docs/t3-v2-support-research.md) · [Design](../../../docs/t3-v2-native-design.md) · [Completed writer proof](../../../docs/t3-v2-proof.md) (evidence, not a ticket).

**Status:** done

- [x] Completed, interrupted, and failed Codex turns retain their meaning and order in T3.
- [x] Supported plans, tool activity, usage, compaction, errors, and resolved approvals/input are represented in T3 history.
- [x] Supported images are visible in T3; attachment bytes and event/projection metadata recover consistently when a write fails or is retried.
- [x] Reimport remains idempotent, and T3 can read the resulting history after restart.
