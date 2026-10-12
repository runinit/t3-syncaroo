# Installed T3 Code `.2994` headless proof

This note records concrete runtime evidence for the currently installed T3 Code build selected as the support target. It complements [the `.2980` to `.2994` source comparison](t3-v2-nightly-update-research.md), which is source-level analysis rather than a runtime test.

## Exact target artifact

- Version: `0.0.46-nightly.20261011.2994`
- Upstream commit: [`d07a07f33c0a1b317dea6234636976231c3688b5`](https://github.com/pingdotgg/t3code/commit/d07a07f33c0a1b317dea6234636976231c3688b5)
- Installed AppImage: `T3-Code-0.0.46-nightly.20261011.2994-x86_64.AppImage`
- SHA-256: `e8c01c767c16cbeb9181dc04f4f1bbc88553b12b746c17f4e9189f266bf036e7`

The AppImage contains Electron and the server entry point `resources/app.asar/apps/server/dist/bin.mjs`. Running that entry point through the packaged Electron binary with `ELECTRON_RUN_AS_NODE=1` reported the exact `.2994` version. Its CLI supports `serve --mode desktop --host --port --base-dir --no-browser <cwd>`.

## Isolation and server startup

The smoke test used a private temporary QA root, `/tmp/t3-v2-headless-2994.8ksIhI`, with separate `home`, XDG config/data, T3 data, Codex home, Claude config, project cwd, and extracted AppImage directories. The root was owner-only. `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `T3CODE_HOME`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR` were set to paths below that root. `T3CODE_DISABLE_AUTO_UPDATE=1` was set. The server listened only on `127.0.0.1`; provider homes were empty.

The sanitized launch form was:

```sh
env \
  HOME="$QA_ROOT/home" \
  XDG_CONFIG_HOME="$QA_ROOT/xdg-config" \
  XDG_DATA_HOME="$QA_ROOT/xdg-data" \
  T3CODE_HOME="$QA_ROOT/t3-home" \
  CODEX_HOME="$QA_ROOT/providers/codex" \
  CLAUDE_CONFIG_DIR="$QA_ROOT/providers/claude" \
  T3CODE_DISABLE_AUTO_UPDATE=1 \
  ELECTRON_RUN_AS_NODE=1 \
  "$APPDIR/t3code" \
  "$APPDIR/resources/app.asar/apps/server/dist/bin.mjs" \
  serve --mode desktop --host 127.0.0.1 --port 51457 \
  --base-dir "$QA_ROOT/t3-home" --no-browser "$QA_ROOT/project"
```

The server reached its ready message and reported its loopback address. `GET /` and `GET /pair` returned HTML, but are only page availability checks. `/api/health` and `/healthz` also return the SPA fallback; they are not health endpoints. The actual environment descriptor `GET /.well-known/t3/environment` returned version `.2994` and orchestration protocol 2. `GET /api/orchestration/shell` with a bearer token and `x-t3-orchestration-protocol: 2` returned HTTP 200 JSON: `schemaVersion: 2`, `sequence: 0`, and empty project, thread, and archive collections.

## Authenticated WebSocket and RPC read

The private server's pairing bootstrap token was used in memory for OAuth token exchange (`urn:ietf:params:oauth:grant-type:token-exchange`) requesting `orchestration:read`. The bearer token requested a WebSocket ticket at `POST /api/auth/websocket-ticket`. The client connected to `/ws` with the ticket and `orchestrationProtocol=2`; the upgrade returned HTTP 101. No credential, ticket, or full pairing URL is retained in this document.

Using Node 26's built-in `fetch` and `WebSocket`, the test sent the JSON Effect-RPC ping and a read-only archived shell query:

```json
{"_tag":"Ping"}
{"_tag":"Request","id":1,"tag":"orchestration.getArchivedShellSnapshot","payload":{},"headers":[]}
```

The server replied with `Pong`, followed by a successful unary result:

```json
{"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":{"schemaVersion":2,"snapshotSequence":0,"projects":[],"threads":[]}}}
```

This confirms authenticated access through the native application RPC, beyond a successful socket handshake or SPA response. The exact QA server process was terminated with SIGTERM after the check; port `51457` was closed. Logs containing ephemeral credentials and generated request traces were redacted or removed. No user T3 profile, installed-app database, existing conversation, provider home, or provider credential was read or changed.

## `message.dispatch` contract for ticket 09

The installed `.2994` frontend sends orchestration commands through the WebSocket RPC method `orchestration.dispatchCommand`. It passes the command object directly as the RPC payload. The server's `/ws` handler checks protocol compatibility, authenticates the WebSocket ticket, and installs the RPC group with session scopes. The pinned source assigns `orchestration.dispatchCommand` the operate scope and `orchestration.getArchivedShellSnapshot` the read scope.

For a settled imported thread, the basic continuation request shape is:

```json
{
  "_tag": "Request",
  "id": 2,
  "tag": "orchestration.dispatchCommand",
  "payload": {
    "type": "message.dispatch",
    "commandId": "<new-command-id>",
    "createdBy": "user",
    "creationSource": "web",
    "threadId": "<imported-t3-thread-id>",
    "messageId": "<new-message-id>",
    "text": "<follow-up text>",
    "attachments": [],
    "dispatchMode": { "type": "start_immediately" }
  },
  "headers": []
}
```

The unary success value is `{ "sequence": <number> }`, carried inside the standard successful `Exit`. The frontend helper builds the `message.dispatch` command and invokes `dispatchCommand(command)`; the server handler submits it to `ThreadMessageIntake.dispatchCommand` and returns the resulting sequence. Optional message context, model selection, plan reference, and continuation-of-run IDs are omitted in this basic settled-thread example. Ticket 09 must use the imported T3 thread and preserve the provider's native Codex session ID or Claude conversation-head binding; see [support research, provider continuation](t3-v2-support-research.md#provider-continuation).

These sources pin the contract to the target commit:

- [WebSocket version check, ticket authentication, JSON RPC setup, and scope installation](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/apps/server/src/ws.ts#L3160-L3211)
- [Server dispatch handler and `{ sequence }` result](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/apps/server/src/ws.ts#L1820-L1865)
- [RPC payload/output schemas](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/packages/contracts/src/rpc.ts#L1620-L1624)
- [Read and operate authorization scopes](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/apps/server/src/auth/RpcAuthorization.ts#L45-L60)
- [Client operation forwards the command directly](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/packages/client-runtime/src/operations/commands.ts#L273-L277)
- [Client helper builds the `message.dispatch` payload](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/packages/client-runtime/src/operations/commands.ts#L694-L714)
- [`message.dispatch` schema and `start_immediately` mode](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/packages/contracts/src/orchestrationV2.ts#L2930-L2968)

The RPC transport and read call are verified. The `message.dispatch` payload is source-backed but was **not sent** during this proof. No Codex or Claude provider call, continuation, or account login was performed. Isolated desktop inspection was explicitly deferred by the user; ticket 09 still requires that GUI check plus the approved minimal real-provider continuation checks. See the ephemeral detailed run note at `/tmp/t3-v2-headless-acceptance-design.md` while it remains available; this tracked document contains the repeatable findings needed after that file is gone.
