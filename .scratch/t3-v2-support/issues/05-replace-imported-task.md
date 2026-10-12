# 05: Replace a divergent imported task safely

**What to build:** When imported history diverges, a user can replace the task with one complete canonical import that owns future synchronization and eligible continuation, while the old task is retired safely.

**Blocked by:** 04: Continue and synchronize both providers.

**References:** [Support spec](../../../docs/t3-v2-support-spec.md) · [Research](../../../docs/t3-v2-support-research.md) · [Design](../../../docs/t3-v2-native-design.md) · [Completed writer proof](../../../docs/t3-v2-proof.md) (evidence, not a ticket).

**Status:** done

- [x] Replacement creates a complete task and retires the old imported task without leaving two synchronization owners.
- [x] Eligible source-session and Claude branch-head identity transfer to the replacement; T3 continuation targets the replacement.
- [x] The operation uses a verified backup and a native atomic event batch; interruption recovery never blindly replays a committed batch.
- [x] Staged attachments are cleaned or recovered safely; repeating a successful replacement is a no-op.

**Verification:** On Node 26.11.1, `test/v2-upgraded-binding.test.ts` passed (1); actual `.2994` legacy-upgrade replacement tests passed (2), including ledger-interruption backup/retry and deleted-task preservation; native replacement tests passed (4), including failed asset staging, sink rollback cleanup, and Claude branch-head continuation; ledger tests passed (3); `npm run typecheck` and `npm run build` passed. The direct upgrade test used the exact pinned `.2994` source tree at `d07a07f33c0a1b317dea6234636976231c3688b5`.
