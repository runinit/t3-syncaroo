# 05: Replace a divergent imported task safely

**What to build:** When imported history diverges, a user can replace the task with one complete canonical import that owns future synchronization and eligible continuation, while the old task is retired safely.

**Blocked by:** 04: Continue and synchronize both providers.

**References:** [Support spec](../../../docs/t3-v2-support-spec.md) · [Research](../../../docs/t3-v2-support-research.md) · [Design](../../../docs/t3-v2-native-design.md) · [Completed writer proof](../../../docs/t3-v2-proof.md) (evidence, not a ticket).

**Status:** ready-for-agent

- [ ] Replacement creates a complete task and retires the old imported task without leaving two synchronization owners.
- [ ] Eligible source-session and Claude branch-head identity transfer to the replacement; T3 continuation targets the replacement.
- [ ] The operation uses a verified backup and a native atomic event batch; interruption recovery never blindly replays a committed batch.
- [ ] Staged attachments are cleaned or recovered safely; repeating a successful replacement is a no-op.
