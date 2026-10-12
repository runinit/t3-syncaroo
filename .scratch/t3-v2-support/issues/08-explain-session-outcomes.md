# 08: Explain every skipped or failed session

**What to build:** During discovery and import, synchronization, or replacement, users can inspect each session's outcome, reason, and next action, while unrelated valid sessions continue through a partial batch.

**Blocked by:** 02: Preserve complete Codex history; 03: Import Claude history with branch-aware continuation; 04: Continue and synchronize both providers; 05: Replace a divergent imported task safely; 06: Reconcile tasks carried through a T3 upgrade; 07: Adopt matching T3 built-in imports.

**References:** [Support spec](../../../docs/t3-v2-support-spec.md) · [Research](../../../docs/t3-v2-support-research.md) · [Design](../../../docs/t3-v2-native-design.md) · [Completed writer proof](../../../docs/t3-v2-proof.md) (evidence, not a ticket).

**Status:** done

- [x] CLI, TUI, and machine-readable output distinguish imported/synced, already imported, deferred by a limit, conflict, and failure.
- [x] Each non-success result explains the session and gives a concrete recovery action without exposing secrets.
- [x] Unreadable or changing source files, workspace mismatches, unsupported/ambiguous histories, and operation failures are not collapsed into an unexplained aggregate count.
- [x] A failing source session does not prevent unrelated valid sessions from completing; aggregate counts match the per-session results.

**Integration evidence:** `353fb87`, `ee88533`, `d3b16b8`, `8facec1`, `758c7dd`, and follow-up `dcf9917`. Focused checks passed on integration: CLI/TUI 26 tests, sources/schema 63 tests (including the pinned `.2994` retained-v1 cursor case), typecheck, and build. The ticket08 producer also ran the full suite (532 passed, 9 fixture skips); final global review remains pending.

Final integration review and the complete CLI/TUI outcome regression checks passed on 2026-10-12; see the [acceptance report](../../../docs/t3-v2-real-provider-acceptance.md#final-retake-2026-10-12).
