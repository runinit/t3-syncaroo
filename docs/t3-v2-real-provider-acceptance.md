# Actual T3 Code `.2994` provider continuation evidence

The [T3 v2 acceptance index](t3-v2-acceptance.md) is the current entry point
for reproducible checks and evidence boundaries. This report preserves dated
acceptance history; earlier failure and pending sections are superseded by the
final retake below.

The final retake on 2026-10-12 closes pinned `.2994` acceptance. Both providers'
real native continuations reconcile without duplicate messages; isolated Codex
and Claude desktop checks pass, including replacement after viewing. The earlier
failures below are retained as historical evidence and are superseded by the
[final retake](#final-retake-2026-10-12).

## Target and isolation

- T3 Code: `0.0.46-nightly.20261011.2994`, commit
  `d07a07f33c0a1b317dea6234636976231c3688b5`.
- Installed AppImage:
  `/home/chris/.local/bin/T3-Code-0.0.46-nightly.20261011.2994-x86_64.AppImage`.
- SHA-256:
  `e8c01c767c16cbeb9181dc04f4f1bbc88553b12b746c17f4e9189f266bf036e7`.
- Runtime was the packaged Electron Node executable and the server bundle from
  the extracted AppImage documented in [headless proof](t3-v2-headless-proof.md).
- Test root: `/tmp/t3-v2-real-provider-2994` (owner-only directory). It held
  separate HOME/XDG paths, T3 home, provider homes, and an empty project folder.
  The server listened only on `127.0.0.1:51459`; update checks were disabled.
- Provider homes started with the minimal disposable Codex and Claude seed
  sessions created for this test. Only the configured authentication files
  needed for those isolated homes were copied; normal provider histories and
  the user's normal T3 profile were not read or changed. The app settings were
  configured through authenticated `server.updateSettings` RPC to use those
  isolated homes and the installed CLI binaries.

The test did not start a GUI or use the host browser. It used authenticated
WebSocket JSON RPC against the native `.2994` server. No credentials, pairing
tokens, access tokens, websocket tickets, auth logs, or raw private prompt
context are included here. The server was stopped after checks; port 51459 has
no listener. The private temp tree remains available for retest, and its server
log and cached access-token file were sanitized/cleared.

## Disposable seed imports

Using `t3-import list`, `show`, and `import` with the private HOME, provider
homes, and `--t3-home /tmp/t3-v2-real-provider-2994/t3-home`, I created one
minimal real provider seed session for each driver and imported it into the
fresh migration-61 database:

| Driver | Native source conversation | Imported T3 thread | Seed result |
| --- | --- | --- | --- |
| Codex | `01a12d9f-0d98-74f2-9b12-b4226632c3f3` | `01a12d9f-0d98-74f2-9b12-b4226632c3f3` | Imported; resumable; 1 turn, 2 messages |
| Claude Code | `e724c029-6a50-46dc-b69b-cd8066669d31` | `27b48cf8-e859-5265-8295-aa6551af7b38` | Imported; resumable; 1 turn, 2 messages |

The seed prompts requested one exact short response and no tools. Both calls
completed. The Claude seed CLI reported USD 0.017327; provider usage for the
later T3 continuation is account activity as well. The test made no claim about
zero cost.

## Enabled provider continuation

The test sent the documented `orchestration.dispatchCommand` RPC with a basic
`message.dispatch` command to each imported thread. T3 returned successful
dispatch sequence acknowledgements and completed each run. Readback through
`orchestration.getThreadProjection` showed the original imported history, the
follow-up user message, and the following exact provider response:

- Codex: `CONTINUED_CODEX_OK`.
- Claude Code: `CONTINUED_CLAUDE_OK`.

The source discovery results still showed the same original native conversation
IDs with updated timestamps, and the provider rollout/Claude JSONL files for
those same IDs contained the new responses. In the native database, the
provider-thread rows retained the strong native-thread references to those
original Codex and Claude IDs. The continuation therefore traversed T3's real
configured provider runtime and reached each original native source session;
this was not a direct CLI continuation outside T3.

## Follow-up synchronization findings

After both T3 runs settled, I stopped the exact owned server and invoked public
`t3-import sync` against each source ID:

- Codex reported `synced`, `turnsAdded: 0`, `turnsAdopted: 1`, and warned that
  one active or indeterminate source turn was ignored. Public `show` then
  reported the source as incomplete even though T3's actual resumed turn had
  `task_started`, a final assistant message, and matching `task_complete` for
  the same turn ID. The isolated rollout shows why: T3 first writes a regular
  Codex user `response_item` beginning `Context handoff (manual_context):`
  before the resumed `task_started`. The current parser treats that injected
  context and compacted historical messages as an incomplete user turn. The
  later provider response is parsed as completed. Ticket 02 is addressing this
  Codex source parsing case; the follow-up must be rerun after it lands.
- Claude reported `history-diverged` and left the task unchanged, with the
  diagnostic that its conversation head no longer matches the imported branch.
  The source conversation ID stayed the same and its new assistant response
  exists in that source JSONL, but the importer did not advance the saved
  native conversation head. This remains an acceptance failure until the branch
  head can be reconciled safely and the same-session continuation/sync is
  retested.

These outcomes are useful regressions to preserve. They do not satisfy the
ticket 04 or 09 sync acceptance criteria.

### Codex source re-read after the parser fix

After the Codex `manual_context` handoff parser fix was merged into the shared
integration branch at `dae4d9f`, I reran only the read-only public CLI `show`
operation against the same isolated Codex rollout. It now reports source
`status: complete`, with two turns, four messages, no warnings, and the real
T3-created continuation included. No provider was invoked. This confirms the
phantom incomplete turn is fixed at source loading; the original sync run above
predates that fix. The final sync check still needs to be rerun with the merged
Claude ledger-head and native continuation/adoption work; that work was not
complete at the time of this retest.

## Disabled provider guard

I disabled only the isolated `codex` provider instance by authenticated native
settings RPC, then attempted one guard-only dispatch to the isolated Codex
thread. The RPC rejected the command with `OrchestrationV2DispatchCommandError`
and the message `Provider instance "codex" is disabled for project <isolated
project id>.` A subsequent native projection read still had exactly the prior
four messages and one completed run. The rejected command did not persist its
user message, create another run, or call the provider. The test setting and
thread were private to the disposable T3 home.

## Actual built-in history import RPC

To give the public importer a target created by T3's own history-import path, I
started a second `.2994` server with a fresh disposable T3 home at
`/tmp/t3-v2-builtin-import-2994/t3-home`, pointed its enabled provider
instances at the existing disposable seed homes, and made no provider calls.
The official `agentSessions.scan` RPC found one project candidate containing
the original two seeded sessions. I created that project through
`projects.mutate`, then called `agentSessions.import` with its project ID and
expected workspace root. The pinned implementation is
[`AgentSessionScanner`](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/apps/server/src/project/AgentSessionScanner.ts)
and
[`AgentSessionImporter`](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/apps/server/src/project/AgentSessionImporter.ts);
the RPC contracts are in
[`agentSessions.ts`](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/packages/contracts/src/agentSessions.ts).

The first call returned `importedCount: 2, skippedCount: 0`. Native readback
showed actual T3-generated `v1_import` threads with these IDs:
`import:codex:01a12d9f-0d98-74f2-9b12-b4226632c3f3` and
`import:claudeAgent:e724c029-6a50-46dc-b69b-cd8066669d31`. Each carries a strong
`nativeThreadRef` to the corresponding original source session. The Codex task
projects 6 user and 3 assistant messages; the Claude task projects 2 user and 2
assistant messages. A repeat call returned the same counts and left the event
store at 31 events, confirming that this built-in path records imported-source
identity and avoids creating duplicate tasks.

The sanitized readback, event counts, project/thread IDs, and source references
are in [the JSON evidence artifact](t3-v2-builtin-import-evidence.json). It
contains no transcript text or auth material. This is the concrete actual
`.2994` built-in-import fixture for the public t3-import adoption retake; it
does not itself prove t3-import adoption, which remains pending the merged 07
hook and its runtime retest. The exact server was stopped, and the private log
and cached access token were sanitized/cleared.

The actual Codex import includes a manual-context handoff and historical
prelude records that the canonical source projection does not represent. A
public importer match against that Codex history should therefore be expected
to reject adoption safely; it is a negative case, not positive adoption
evidence. Ticket 09 is preparing a frozen pre-handoff Codex fixture for the
positive case. The actual Claude import projects two user and two assistant
messages and is a positive candidate once the 07 adoption hook is integrated;
that hook has not yet been runtime-verified here.

## Historical remaining gates (superseded by the final retake)

- Retest Codex sync after the manual-context parser fix.
- Resolve and retest Claude branch-head advancement/sync on the same imported
  source session.
- Run the full ticket-09 acceptance only after tickets 05–08 and the final
  integration are ready; this report is evidence, not a completion claim.
- The 54-scenario legacy compatibility harness passed in an isolated worktree:
  `./node_modules/.bin/tsx scripts/compatibility/run.ts` reported all 54
  Codex/Claude migration and migration-upgrade scenarios passing for migrations
  40–53. `npm run compat:prepare` used a filtered clone of the official T3
  repository at `/tmp/t3-v2-compat-reference` and installed the pinned Effect
  versions in the isolated worktree. Results are at
  `/tmp/t3-import-real-provider-acceptance/artifacts/compatibility/run-TXbKgH/results.json`.
  This is evidence for legacy compatibility only; it does not replace the
  pinned `.2994` provider/desktop checks above.
- Isolated desktop inspection remains explicitly deferred by the user.

## Codex GUI retake, 2026-10-11 (Toronto)

The user resumed **Codex** GUI acceptance using `agent-workspace-linux`.
This retake used the pinned `.2994` Electron app on the hidden workspace
display, importer checkout `8a65134`, and separate disposable HOME, XDG,
Electron profile, T3 home, and importer ledger paths. The starting database
was copied from the disposable provider acceptance home above. No new provider
request was sent. The workspace was stopped after inspection.

Observed passes:

- The real Codex seed and existing `CONTINUED_CODEX_OK` response render,
  together with the historical usage notice.
- A controlled Codex canonical fixture imported through `importConversations`
  renders both messages, the attached PNG thumbnail and full-size preview,
  proposed-plan Markdown, completed checklist, and expandable shell input/output.
- In a second disposable home, replacement **before opening the imported task**
  succeeds with a backup. Two subsequent `syncConversations` calls both return
  `up-to-date`, zero added/adopted turns, and zero events. After opening T3,
  the replacement messages, plan and image render. The sidebar contains one
  fixture task; database inspection confirms one live replacement and one
  deleted original, with integrity `ok`.

Initial acceptance failure (resolved below): opening the original fixture in T3 appends a native
`thread.visited` event. After closing T3, replacement of changed source history
returns `history-conflict`, with the warning “The native event stream is not the
deterministic t3-import history owned by this ledger record.” The stream contains
the eleven imported events followed by `thread.visited`; no message was sent
or history edited in T3. The original task, plan and image remain intact after
the refusal. This is a reproducible replacement-after-viewing gap in the strict
event-ownership check in `src/target/v2/replace.ts`, and initially left Codex acceptance
incomplete. The changed-source sync refusals in that case are expected safety
behavior, not independent sync failures.

Local evidence (temporary files, not committed):

- `/tmp/t3-codex-gui-2994/fixture.ts`: reproducible canonical fixture driver.
- `/tmp/t3-codex-gui-2994/02-real-codex.png`: real imported continuation.
- `/tmp/t3-codex-gui-2994/05-rich-history.png`, `07-command-output.png`,
  `09-image-preview.png`: rich-history rendering.
- `/tmp/t3-codex-gui-2994/visited-event-evidence.json`,
  `10-replacement-guard.png`: original visit event and preserved original after
  the initial replacement refusal.
- `/tmp/t3-codex-gui-replaced-2994/replacement-result.json`,
  `ownership-evidence.json`, `03-replacement-visible.png`: successful replacement
  before viewing, one live owner, and visible replacement content.

The controlled fixture uses the public importer operation boundary rather than
source discovery. This run does not retest real provider execution, Claude GUI
acceptance, or the full automated suite, and does not close ticket 09.

### Replacement-after-viewing fix and verification

The ownership check now decodes unexpected event IDs through the existing
pinned native helper and permits only `thread.visited` for that same thread
and sequence. It still checks ordering of every event and the deterministic
imported prefix, and rejects other native events. Regression coverage first
failed with `history-conflict`, then passed after the fix; it covers repeated
visits, replacement content and retirement, synchronization ownership, and
refusal of an extra native `thread.metadata-updated` event alongside a visit.

Retrying against the original disposable GUI profile, with its actual native
visit still present, now returns `replaced` with a backup. Both follow-up syncs
return `up-to-date` with zero events. Reopening the pinned Electron app confirms
the replacement text, image and plan render in one fixture task. Screenshot:
`/tmp/t3-codex-gui-2994/12-after-visited-fix.png`; the updated
`replacement-result.json` in that directory records the successful retry.
The workspace was stopped. No new provider request was made.

Validation: 39 focused tests pass across replacement, native continuation,
built-in adoption, import and history; all three converted-task replacement
tests also pass with the pinned upstream source configured. Typecheck, build,
and `git diff --check` pass. The existing untracked
`test/v2-upgrade-sync-replace.test.ts` has four failures with that source
configured. The identical four failures reproduce with `src/target/v2/replace.ts`
restored from `HEAD` in an isolated baseline directory, so they predate this
fix. Baseline log: `/tmp/t3-visited-baseline-cinxglet/baseline-results.log`.
Those upgrade acceptance failures remain open; this fix does not close the
overall acceptance ticket.

## Final retake: 2026-10-12

The remaining upgrade fixture tests exposed two implementation gaps: sync did
not restore and reconcile converted mappings, and missing-ledger Claude
recovery did not inspect deterministic identities from earlier assistant heads
in the selected lineage. Both are fixed. The real migration fixture now seeds
its optional attachment before running T3's actual conversion and compaction;
its public-operation checks cover missing image recovery, preview without writes,
old-target-only ledgers, replacement, edited history and wrong project ownership.
The retained-v1-tail schema test now creates its own copied fixture rather than
assuming every supplied v2 database contains such a tail.

Native continuation reconciliation now verifies exact source/native turn and
assistant-item lineage, accounts for native clocks/origin labels, and excludes
checkpoint items only through completed run/attempt/node/checkpoint provenance.
A shared root checkpoint scope may advance to a later completed run without
invalidating the earlier run's own checkpoint links. Claude inline handoffs are
recognized only when their persisted delivery and exact historical item content
reconstruct the source prompt. Arbitrary prompt prefixes, foreign references,
extra activity, changed content and incomplete operational chains remain conflicts.
Source usage notices missing from T3's native transcript are appended once;
messages are never replayed to fill that difference. Saved native identities also
allow unchanged native tasks to return `already-current` for replacement.

### Real provider follow-up

A fresh disposable target at `/tmp/t3-v2-final-provider-acceptance` copies the
actual `.2994` provider-run database and reconstructs each known original
one-turn import checkpoint in a new ledger. It uses the unchanged original
provider source files; no further provider calls were made. The built CLI reports:

| Source | First sync | Transcript turns added | Native turns adopted | Supplemental usage events | Repeat sync | Replacement preview |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | synced | 0 | 1 | 1 | up-to-date, 0 events | already-current |
| Claude | synced | 0 | 1 | 1 | up-to-date, 0 events | already-current |

Both continuations still identify the original sessions documented above, with
four projected messages per task. Sanitized operation results are under that
disposable root as `codex-sync.json`, `claude-sync.json`, their `*-repeat.json`
files and `*-replace-preview.json` files. The older Codex ledger that had adopted
a native turn without retaining its row identities was also recovered after a
complete source/native proof and repeated with zero events.

### Claude desktop completion

Using the `agent-workspace-linux` skill, the exact extracted `.2994` Electron
application ran on the hidden workspace display with a separate HOME, XDG paths,
Electron profile and T3 home at `/tmp/t3-claude-gui-2994`. The controlled Claude
fixture contains two messages, a real PNG, a plan and tool/task activity. This
synthetic rendering fixture has resume disabled and no provider credentials;
its authentication banner is expected. Actual authenticated continuation is
covered separately by the real-provider evidence above.

The desktop rendered the messages, logo thumbnail and full image preview,
expanded command activity and plan. After visiting the original task, public
replacement retired `d13b00ce-eb9f-5741-ba2a-cb4bac2e7fd9` and created
`51f25370-78b4-5aed-945d-a0ed38d96785`. Restarting Electron displayed the
replacement text, image and plan with exactly one visible task. Two syncs
reported `up-to-date`, zero events and the replacement as the sole owner.
Screenshots `05-image.png`, `06-image-preview.png`, and
`09-replacement-image-plan.png` are retained under the disposable root. The
workspace and all of its apps were stopped. Together with the Codex GUI retake
above, this completes both desktop checks without touching the host desktop.

### Verification and compatibility limits

- Full Vitest suite with the pinned v2 fixture and real migration source enabled:
  **638 tests across 28 files**. The new runtime-timestamp/source-usage and
  unchanged-native-replacement regression failed before their fixes; the shared
  checkpoint-scope regression also failed before its fix.
- Typecheck, build, vendored-helper verification and packed-consumer installation,
  import, retry, divergent-history refusal and native readback pass.
- All **54 legacy integration scenarios** for migrations 40–53 pass in this
  checkout; result artifact: `artifacts/compatibility/run-Hi0nPz/results.json`.
  The cached source snapshots were checked against the committed reference pins
  before reuse.
- Final manual review checked the changes against the supplied project rules and
  support spec, including negative ownership/source/project cases and preserved
  overlapping work. No external PR, publication or normal-profile migration was
  performed.
- Positive built-in adoption is verified by public operations against native
  EventSink-projected exact Codex and Claude fixtures. The actual T3 wizard
  imports of these real sessions omit usage/activity and, for Codex, contain
  additional handoff/prelude messages. They correctly remain conflicts under the
  spec's complete-history rule. The frozen pre-handoff Codex source likewise
  contains a usage snapshot omitted by the wizard; the final CLI retake refuses
  it without writing. This is a deliberate compatibility boundary, not a
  successful adoption claim for reduced history.
- Compatibility is pinned to `.2994`; no compatibility claim is made for
  unvalidated future nightlies. All acceptance work used disposable data; the
  user's normal T3 home and provider histories remain untouched.
