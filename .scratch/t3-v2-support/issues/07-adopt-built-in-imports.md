# 07: Adopt matching T3 built-in imports

**What to build:** A user can adopt a conversation already imported by T3's built-in wizard for future t3-import synchronization and replacement only when its source identity and complete normalized history match.

**Blocked by:** 02: Preserve complete Codex history; 03: Import Claude history with branch-aware continuation; 04: Continue and synchronize both providers.

**References:** [Support spec](../../../docs/t3-v2-support-spec.md) · [Research](../../../docs/t3-v2-support-research.md) · [Design](../../../docs/t3-v2-native-design.md) · [Completed writer proof](../../../docs/t3-v2-proof.md) (evidence, not a ticket).

**Status:** ready-for-agent

- [ ] The deterministic built-in thread identity, project, provider, source session, and full supported canonical history are verified before adoption.
- [ ] An exact match gains t3-import synchronization and replacement ownership without creating another task; eligible source-session continuation remains attached to the adopted task.
- [ ] Reduced, divergent, incomplete, or ambiguous histories are reported as actionable conflicts; matching title or `historyOrigin` alone never establishes a match.
