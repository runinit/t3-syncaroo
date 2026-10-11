# 03: Import Claude history with branch-aware continuation

**What to build:** A user can import a Claude Code source session and its selected conversation branch into T3, preserving supported history and enough native branch identity to continue that same session.

**Blocked by:** 01: Import a settled Codex conversation into v2. This can proceed alongside 02 if the shared event mapping is stable.

**References:** [Support spec](../../../docs/t3-v2-support-spec.md) · [Research](../../../docs/t3-v2-support-research.md) · [Design](../../../docs/t3-v2-native-design.md) · [Completed writer proof](../../../docs/t3-v2-proof.md) (evidence, not a ticket).

**Status:** ready-for-agent

- [ ] Completed, interrupted, and failed Claude turns retain their meaning and order, with supported plans, activity, errors, and images visible in T3.
- [ ] The imported provider-thread reference identifies the original Claude session and selected conversation head needed for continuation.
- [ ] A genuine alternate branch remains separately selectable; ambiguous branches are not guessed for synchronization or replacement.
- [ ] Reimport is idempotent, and the imported branch remains readable after T3 restarts.
