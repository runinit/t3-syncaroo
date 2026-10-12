# Actual T3 Code `.2994` provider continuation evidence

This is a bounded headless acceptance run for the exact installed T3 Code
nightly. It verifies the real application RPC and provider path against private
disposable data. It does not close ticket 09: GUI inspection was deferred by the
user, and the follow-up sync checks exposed issues that need fixes and retesting.

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

## Disabled provider guard

I disabled only the isolated `codex` provider instance by authenticated native
settings RPC, then attempted one guard-only dispatch to the isolated Codex
thread. The RPC rejected the command with `OrchestrationV2DispatchCommandError`
and the message `Provider instance "codex" is disabled for project <isolated
project id>.` A subsequent native projection read still had exactly the prior
four messages and one completed run. The rejected command did not persist its
user message, create another run, or call the provider. The test setting and
thread were private to the disposable T3 home.

## Remaining gates

- Retest Codex sync after the manual-context parser fix.
- Resolve and retest Claude branch-head advancement/sync on the same imported
  source session.
- Run the full ticket-09 acceptance only after tickets 05–08 and the final
  integration are ready; this report is evidence, not a completion claim.
- The 54-scenario compatibility harness was not run in this environment:
  `scripts/compatibility/prepare.mjs` requires the pinned reference checkout at
  `repos/t3code`, which is absent here, and downloads/install steps for all
  pinned Effect reference dependencies. The harness can be run after that
  checkout is available; its existence does not replace the real provider
  checks recorded above.
- Isolated desktop inspection remains explicitly deferred by the user.
