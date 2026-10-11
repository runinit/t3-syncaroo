# 09: Complete pinned-nightly acceptance

**What to build:** The agreed t3-import feature set works end to end on T3 Code `0.0.46-nightly.20261011.2980`, remains compatible with T3 migrations 40–53, and is verified through the pinned runtime, isolated desktop, and disposable real provider sessions.

**Blocked by:** 01: Import a settled Codex conversation into v2; 02: Preserve complete Codex history; 03: Import Claude history with branch-aware continuation; 04: Continue and synchronize both providers; 05: Replace a divergent imported task safely; 06: Reconcile tasks carried through a T3 upgrade; 07: Adopt matching T3 built-in imports; 08: Explain every skipped or failed session.

**References:** [Support spec](../../../docs/t3-v2-support-spec.md) · [Research](../../../docs/t3-v2-support-research.md) · [Design](../../../docs/t3-v2-native-design.md) · [Completed writer proof](../../../docs/t3-v2-proof.md) (evidence, not a ticket).

**Status:** ready-for-agent

- [ ] Existing supported T3 migrations 40–53 and relevant test, typecheck, build, and package checks pass.
- [ ] In an isolated T3 home, desktop inspection confirms messages, images, plans/activity, replacement visibility, and one synchronization owner.
- [ ] Minimal disposable Codex and Claude continuations use the original native session/branch; follow-up sync recognizes the resulting turns without duplicates.
- [ ] The pinned runtime and all checks leave the user's normal T3 home untouched; results and any remaining compatibility limits are recorded.
