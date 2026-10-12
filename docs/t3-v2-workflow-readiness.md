# Historical T3 v2 workflow readiness

This assessment predates implementation and is retained as planning history. Its branch, ticket, baseline, and open-gate status are stale. For current validation and status, use the [T3 v2 acceptance index](t3-v2-acceptance.md) and its linked dated evidence.

Assessment for the implementation effort in [the spec](t3-v2-support-spec.md), using the [pinned-source research](t3-v2-support-research.md) and completed isolated writer proof. Production packaging and product behavior still need implementation.

## Repository and workflow state

- The checkout is on the `t3-v2-support` integration branch at commit `fe2fa2e`, which includes the support docs, proof, nine ticket files, scoped native-script allowance, and follow-up ticket clarifications. A separate ticket-01 worktree is present at `/home/chris/04_Src/t3-import-ticket-01`; preserve it. `.memsearch/` and this readiness note remain untracked shared files.
- There is a GitHub remote, but no tracker configuration (`docs/agents/issue-tracker.md`) or `.scratch/` convention yet. The repo has no root `AGENTS.md`/`CLAUDE.md`, `CODING_STANDARDS.md`, `CONTRIBUTING.md`, or ADRs. `GLOSSARY.md` is present and defines the domain language. Existing test seams include the Vitest suite and `scripts/compatibility/` harness; package scripts include test, typecheck, build, and compatibility checks.
- The user selected **local Markdown** under `.scratch/t3-v2-support/` and approved the nine-ticket breakdown. All nine ticket files are published under `.scratch/t3-v2-support/issues/` with `ready-for-agent` status; no external issues or persistent tracker configuration were created. The setup skill's separate persistent-configuration flow would ask which root instruction file to create; that unrelated setup was avoided.

## Approved verification boundaries and gates

The user-approved spec authorizes three verification boundaries: importer commands and operations (target selection, preview, import, sync, replacement, recovery, structured outcomes); pinned T3 runtime against synthetic homes using real migrations, decoding, projection and provider routing; and isolated desktop plus minimal disposable Codex/Claude continuation. It also requires legacy 40–53 regression coverage. These are pre-agreed seams, confirmed in the final shared-understanding checkpoint. Mapping the importer boundary onto existing public operations, and the runtime boundary onto T3's read/projector interface, stays within that approval; do not ask the user to approve those same categories again. The TDD skill still requires writing down each seam and what it catches or misses. Its exact rule is: “Before writing any test, write down the seams under test and confirm them with the user.” Apply that gate only if implementation proposes a genuinely new or lower-level seam beyond the approved public operations/runtime/desktop/provider boundaries. TDD also requires one failing behavior test before each minimal implementation slice.

The synthetic EventSink proof is complete and clears the source-level writer gate for a single text-only thread. It verifies persistence/projection across restart, provider binding, duplicate preflight, and atomic rollback. It does not establish production packaging, attachment recovery, full event mapping, UI rendering, or actual provider continuation. Those remain implementation and acceptance gates.

The completed proof runner is under `scripts/compatibility/v2-proof/`. It covers one text-only thread; it is completed evidence, not an open implementation ticket. Production package integration remains to be delivered.

## Baseline checks

The initial `npm ci` blocked native build scripts under the user's `/home/chris/.npmrc` policy (`allow-scripts=agent-browser`). Per the authorized, scoped repo-level exception, `npm install-scripts approve better-sqlite3` added only `"allowScripts": { "better-sqlite3@12.11.1": true }` to `package.json`; the user config remains untouched and `package-lock.json` is unchanged. `npm rebuild better-sqlite3` then created a working native binding. `npm test` passed all 493 tests across 10 files, including migrations 40–53 fixtures; `npm run typecheck` and `npm run build` also passed. The esbuild script remains unapproved, but the build passes without it, so no extra approval was added. The full 54-scenario legacy compatibility harness was not run; package baseline passed and the parent requested that this remain bounded while v2 packaging is unresolved. `npm ci` reported four dependency audit findings (one moderate, one high, two critical).

## Minimal next-step proposal

A user decision in this session selecting `.scratch/t3-v2-support/issues/` as the tracker is enough to provide the custom tracker workflow to `/to-tickets` and `/implement-spec`; their precondition is that a tracker be provided, not that the setup skill must be run. This avoids creating root agent instructions or configuration unrelated to the implementation. If a persistent repo-wide setup is desired later, handle it separately; `setup-matt-pocock-skills` has a confirmation-and-edit workflow and, with no existing root instruction file, asks which one to create. For strict compatibility with the local ticket template, use `ready-for-agent` initially and `in-progress`, `blocked`, `done` as work proceeds; a bare `ready` label would differ from that template.

For TDD, map the pre-approved seams to these public boundaries and evidence limits:

- **Importer operation boundary:** `resolveTargetPaths`, `validateTargetDatabase`, `importConversations`, `inspectConversationSync`/`syncConversations`, and `inspectConversationReplacement`/`replaceConversations`, called with canonical conversations and a disposable target home. This verifies target selection, dry runs, operation results, repeatability, conflicts, and recovery-facing side effects. It does not establish T3's rendering or actual provider execution.
- **CLI boundary:** invoke the built `t3-import` commands (`doctor`, `list`, `show`, `import`, `sync`, `replace`) against temporary source fixtures and a synthetic T3 home. This verifies user-visible selection, preview, exit codes and structured/per-session outcomes. It does not prove native event projection or desktop behavior.
- **Pinned T3 runtime boundary:** write through the pinned native sink in a temporary home, reopen with T3's public read/projector interfaces, and assert visible thread/history and sequence consistency. This verifies native persistence and projections; it does not prove desktop layout or provider accounts.
- **Isolated desktop and disposable provider boundary:** use a separate T3 home for visual history/assets/replacement inspection, then minimal Codex and Claude continuations and follow-up sync. This verifies rendering and real routing for those cases; it is intentionally the final acceptance gate after synthetic evidence.

The spec already approves these test boundaries, so using the mapped public interfaces above does not need repeated authorization. If implementation proposes a genuinely new or lower-level seam, confirm it before testing there under TDD. The numbered slices below were approved by the user and published as local tickets. The native writer proof is completed evidence, not an open ticket.

| # | Complete user-visible slice | Blocked by |
|---|---|---|
| 1 | **Import a settled Codex text conversation into v2.** Package the pinned writer for the CLI; safely detect/validate/preview/select v2 storage; import text and original Codex provider binding into a disposable v2 home. T3 reads it after restart; dry-run/retry are safe; invalid v2 refuses without fallback; legacy 40–53 remains usable. | None |
| 2 | **Preserve complete Codex history.** Codex imports retain supported plans, activity/tool/error/compaction history and images; attachment bytes and event/projection changes recover together after interruption. | 1 |
| 3 | **Import Claude history with branch-aware continuation.** Import the selected Claude branch with supported history/assets and its exact native conversation-head binding, so T3 can continue that branch. | 1 (can proceed alongside 2 if shared event mapping is stable) |
| 4 | **Continue and synchronize both providers.** Eligible Codex/Claude tasks resume the original source session/branch; sync adds new settled turns once, adopts matching turns continued through T3, excludes active turns, and reports changed/deleted history as conflict. | 2, 3 |
| 5 | **Replace a divergent task safely.** Replacement creates a complete canonical task, retires the old one, transfers eligible sync/resume identity, and can recover interrupted retries without duplicate tasks or orphaned assets. | 4 |
| 6 | **Reconcile tasks carried through a T3 upgrade.** Verify identity/history after v1 conversion, recover when the importer ledger is missing, survive event compaction, and report ambiguous/incomplete matches as conflicts. | 1, 4 |
| 7 | **Adopt matching T3 built-in imports.** Adopt only when source identity and complete normalized history match; divergent, reduced, or ambiguous imports remain actionable conflicts. | 2, 3, 4 |
| 8 | **Explain every skipped or failed session.** Discovery and import/sync/replace distinguish imported, already imported, deferred by a limit, conflict, and failure with reason and next action, while valid sessions in a batch proceed. | 2–7 |
| 9 | **Complete pinned-nightly acceptance.** Verify visible history/assets/replacement in an isolated T3 desktop, run minimal disposable real Codex and Claude continuations plus follow-up sync, and pass all supported legacy 40–53 scenarios and relevant package checks. | 1–8 |

These edges reflect behavior: sync needs both provider imports; adoption needs the import/identity rules it adopts; and complete diagnostics need each discovery/write path. Asset recovery is a hard acceptance boundary of slice 2 and 5; the text-only proof does not establish it. The proof established a viable native writer path and its transaction semantics, but did not test its production package layout, rich history, attachments, UI or real provider calls.

The local ticket files are in `.scratch/t3-v2-support/issues/01-import-codex-text-into-v2.md` through `09-pinned-nightly-acceptance.md`. If `/implement-spec` is used, its tracker precondition is satisfied by the session-level local Markdown choice; it uses an integration branch/worktrees, TDD per ticket, merges, then a two-axis `code-review`. No external tracker or persistent root-file setup is involved.

## Scope and permissions

The readiness work created the nine approved local ticket files and changed `package.json` only by the approved `better-sqlite3@12.11.1` install-script allowance; `package-lock.json` is unchanged. It created no external issues or persistent tracker/root configuration and did not touch installed T3 data. The coordinating agent completed the isolated writer proof. No recurring schedule is justified yet: this is pinned compatibility work, not an ongoing maintenance objective.
