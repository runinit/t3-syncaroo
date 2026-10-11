# 08: Explain every skipped or failed session

**What to build:** During discovery and import, synchronization, or replacement, users can inspect each session's outcome, reason, and next action, while unrelated valid sessions continue through a partial batch.

**Blocked by:** 02: Preserve complete Codex history; 03: Import Claude history with branch-aware continuation; 04: Continue and synchronize both providers; 05: Replace a divergent imported task safely; 06: Reconcile tasks carried through a T3 upgrade; 07: Adopt matching T3 built-in imports.

**References:** [Support spec](../../../docs/t3-v2-support-spec.md) · [Research](../../../docs/t3-v2-support-research.md) · [Design](../../../docs/t3-v2-native-design.md) · [Completed writer proof](../../../docs/t3-v2-proof.md) (evidence, not a ticket).

**Status:** ready-for-agent

- [ ] CLI, TUI, and machine-readable output distinguish imported/synced, already imported, deferred by a limit, conflict, and failure.
- [ ] Each non-success result explains the session and gives a concrete recovery action without exposing secrets.
- [ ] Unreadable or changing source files, workspace mismatches, unsupported/ambiguous histories, and operation failures are not collapsed into an unexplained aggregate count.
- [ ] A failing source session does not prevent unrelated valid sessions from completing; aggregate counts match the per-session results.
