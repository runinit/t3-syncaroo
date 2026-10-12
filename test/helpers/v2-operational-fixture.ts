import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalThread } from "../../src/core/types.js";

const nativeHelper = new URL("../../vendor/t3-v2-native-helper.mjs", import.meta.url).pathname;

export interface NativeBuiltinFixtureOptions {
  threadId?: string;
  projectId?: string;
  providerThreadId?: string;
  nativeSessionId?: string;
  nativeConversationHeadId?: string;
  runtimeTimestamps?: boolean;
  operationalCheckpoint?: boolean;
}

export interface NativeBuiltinFixture {
  dbPath: string;
  projectId: string;
  threadId: string;
  providerThreadId: string;
  events: Array<Record<string, any>>;
  checkpoint?: { runId: string; attemptId: string; scopeId: string; checkpointId: string; itemId: string };
  target: { exists: true; thread: Record<string, unknown>; records: Record<string, any>; threadId: string };
}

function writeEvents(dbPath: string, events: Array<Record<string, any>>, projectEvent?: Record<string, any>): Record<string, any> {
  const result = JSON.parse(execFileSync(process.execPath, [nativeHelper], {
    input: JSON.stringify({ op: "write", dbPath, events, ...(projectEvent ? { projectEvent } : {}) }), encoding: "utf8",
  })) as Record<string, any>;
  if (!result.ok) throw new Error(`Pinned native EventSink rejected fixture events: ${result.error ?? "unknown error"}`);
  return result;
}

/** Build a synthetic imported prefix plus one provider-native continuation using the pinned EventSink. */
export function writeNativeBuiltinFixture(
  root: string,
  thread: CanonicalThread,
  instance = "codex",
  options: NativeBuiltinFixtureOptions = {},
): NativeBuiltinFixture {
  if (thread.turns.length < 2) throw new Error("Native builtin fixture requires an imported prefix and one continuation.");
  const dbPath = join(root, "userdata", "statev2.sqlite");
  mkdirSync(join(root, "userdata"), { recursive: true });
  const projectId = options.projectId ?? `project:adoption:${thread.sourceSessionId}`;
  const threadId = options.threadId ?? `import:${instance}:${thread.sourceSessionId}`;
  const providerThreadId = options.providerThreadId ?? `provider-thread:adoption:${thread.sourceSessionId}`;
  const driver = instance;
  const events: Array<Record<string, any>> = [{
    id: `agent-session-import:v2:thread:${threadId}:created`, type: "thread.created", threadId,
    providerInstanceId: instance, occurredAt: thread.createdAt,
    payload: { createdBy: "system", creationSource: "server", id: threadId, projectId, title: thread.title,
      providerInstanceId: instance, modelSelection: { instanceId: instance, model: thread.model }, runtimeMode: "full-access",
      interactionMode: "default", branch: null, worktreePath: null, linkedPullRequest: null, branchPullRequest: null,
      activeProviderThreadId: providerThreadId, historyOrigin: "v1_import",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }, forkedFrom: null,
      createdAt: thread.createdAt, updatedAt: thread.updatedAt, archivedAt: null, settledOverride: "settled",
      settledAt: thread.updatedAt, unsettledAt: null, snoozedUntil: null, snoozedAt: null, pinnedAt: null,
      pinOrderKey: null, activeOrderKey: null, lastVisitedAt: null, deletedAt: null },
  }];
  const base = (id: string, messageId: string, ordinal: number, type: string, at: string, fields: Record<string, unknown>) => ({
    id, threadId, runId: null, nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null,
    parentItemId: null, ordinal, status: "completed", title: null, startedAt: at, completedAt: at, updatedAt: at,
    type, messageId, ...fields,
  });
  const prefix = thread.turns[0]!;
  const prefixMessages = [prefix.user, ...prefix.assistant];
  prefixMessages.forEach((message, index) => {
    const suffix = String(index).padStart(6, "0");
    const id = `${threadId}:${suffix}`;
    const itemId = `agent-session-import:v2:turn-item:${threadId}:${suffix}`;
    const at = message.timestamp;
    events.push({ id: `agent-session-import:v2:message:${threadId}:${suffix}`, type: "message.updated", threadId, occurredAt: at,
      payload: { createdBy: message.role === "user" ? "user" : "agent", creationSource: "server", id, threadId, runId: null,
        nodeId: null, role: message.role, text: message.text, attachments: [], streaming: false, createdAt: at, updatedAt: at } });
    const item = message.role === "user"
      ? base(itemId, id, index + 1, "user_message", at, { createdBy: "user", creationSource: "server", inputIntent: "turn_start", text: message.text, attachments: [] })
      : base(itemId, id, index + 1, "assistant_message", at, { text: message.text, streaming: false });
    events.push({ id: `agent-session-import:v2:turn-item:${threadId}:${suffix}`, type: "turn-item.updated", threadId, occurredAt: at, payload: item });
  });
  let checkpointFixture: ReturnType<typeof operationalCheckpointEvents> | undefined;
  if (options.operationalCheckpoint) {
    if (thread.turns.length !== 2) throw new Error("Operational checkpoint fixture supports one native continuation after the imported prefix.");
    const turn = thread.turns[1]!;
    const assistantNativeId = turn.assistant.at(-1)?.sourceId.replace(/:text:\d+$/u, "");
    const sourceNativeTurnId = driver === "claudeAgent" ? assistantNativeId : turn.id;
    if (!assistantNativeId || !sourceNativeTurnId) throw new Error("Operational checkpoint requires a source-native continuation.");
    const providerTurnId = `native-provider-turn:${thread.sourceSessionId}:1`;
    const nodeId = `native-node:${sourceNativeTurnId}`;
    checkpointFixture = operationalCheckpointEvents({ threadId, providerThreadId, providerInstanceId: instance,
      sourceNativeTurnId, providerTurnId, nodeId, userMessageId: `native-message:${thread.sourceSessionId}:${turn.user.sourceId}` });
    events.push(...checkpointFixture.beforeContinuationEvents);
  }
  let ordinal = prefixMessages.length;
  for (const [turnIndex, turn] of thread.turns.slice(1).entries()) {
    const nativeProviderTurnId = `native-provider-turn:${thread.sourceSessionId}:${turnIndex + 1}`;
    const assistant = turn.assistant.at(-1);
    const assistantNativeId = assistant?.sourceId.replace(/:text:\d+$/u, "");
    const nativeTurnId = driver === "claudeAgent" ? assistantNativeId : turn.id;
    if (!nativeTurnId || !assistantNativeId) throw new Error("Continuation has no source-native turn and assistant identities.");
    const nodeId = `native-node:${nativeTurnId}`;
    events.push({ id: `native-provider-event:${thread.sourceSessionId}:${turnIndex + 1}`, type: "provider-turn.updated", threadId,
      driver, providerInstanceId: instance, occurredAt: turn.completedAt ?? turn.startedAt,
      payload: { id: nativeProviderTurnId, providerThreadId, nodeId,
        runAttemptId: checkpointFixture && turnIndex === thread.turns.length - 2 ? checkpointFixture.ids.attemptId : null,
        nativeTurnRef: { driver, nativeId: nativeTurnId, strength: driver === "claudeAgent" ? "weak" : "strong" },
        ordinal: turnIndex + 1, status: turn.status, startedAt: turn.startedAt, completedAt: turn.completedAt ?? null } });
    for (const message of [turn.user, ...turn.assistant]) {
      ordinal += 1;
      const id = `native-message:${thread.sourceSessionId}:${message.sourceId}`;
      const itemId = `native-item:${thread.sourceSessionId}:${message.sourceId}`;
      const at = message.timestamp;
      const nativeId = message.role === "assistant" && driver === "claudeAgent"
        ? message.sourceId.replace(/:text:\d+$/u, "") : message.sourceId;
      events.push({ id: `native-message-event:${thread.sourceSessionId}:${message.sourceId}`, type: "message.updated", threadId, occurredAt: at,
        payload: { createdBy: message.role === "user" ? "user" : "agent", creationSource: "server", id, threadId,
          runId: null, nodeId: null, role: message.role, text: message.text, attachments: [], streaming: false, createdAt: at, updatedAt: at } });
      const item = message.role === "user"
        ? base(itemId, id, ordinal, "user_message", at, { createdBy: "user", creationSource: "server", inputIntent: "turn_start", text: message.text, attachments: [], providerThreadId, providerTurnId: null })
        : base(itemId, id, ordinal, "assistant_message", at, { text: message.text, streaming: false, providerThreadId, providerTurnId: nativeProviderTurnId,
          nativeItemRef: { driver, nativeId, strength: "strong" } });
      events.push({ id: `native-item-event:${thread.sourceSessionId}:${message.sourceId}`, type: "turn-item.updated", threadId,
        driver, providerInstanceId: instance, occurredAt: at, payload: item });
    }
  }
  if (checkpointFixture) events.push(...checkpointFixture.afterContinuationEvents);
  if (options.runtimeTimestamps) {
    for (const event of events) {
      const row = event.payload as Record<string, any>;
      if (!String(row?.id).startsWith("native-")) continue;
      if (event.type === "message.updated") {
        row.creationSource = row.role === "user" ? "web" : "provider";
        row.createdAt = "2026-01-02T00:00:01.000Z"; row.updatedAt = "2026-01-02T00:00:03.000Z";
      } else if (event.type === "turn-item.updated") {
        row.startedAt = "2026-01-02T00:00:01.000Z"; row.completedAt = "2026-01-02T00:00:03.000Z"; row.updatedAt = "2026-01-02T00:00:03.000Z";
      }
    }
  }
  events.push({ id: `agent-session-import:v2:provider-thread:${providerThreadId}`, type: "provider-thread.updated", threadId,
    driver, providerInstanceId: instance, occurredAt: thread.updatedAt,
    payload: { id: providerThreadId, driver, providerInstanceId: instance, providerSessionId: null, appThreadId: threadId,
      ownerNodeId: null, nativeThreadRef: { driver, nativeId: options.nativeSessionId ?? thread.sourceSessionId, strength: "strong" },
      nativeConversationHeadRef: options.nativeConversationHeadId
        ? { driver, nativeId: options.nativeConversationHeadId, strength: "strong" } : null,
      status: "idle", firstRunOrdinal: null, lastRunOrdinal: null, handoffIds: [],
      forkedFrom: null, pendingBackgroundTasks: [], createdAt: thread.createdAt, updatedAt: thread.updatedAt } });
  const projectEvent = { commandId: `command:adoption:${thread.sourceSessionId}`, commandType: "project.create", acceptedAt: thread.createdAt,
    event: { sequence: 1, eventId: `event:adoption:${thread.sourceSessionId}:project`, aggregateKind: "project", aggregateId: projectId,
      occurredAt: thread.createdAt, commandId: null, causationEventId: null, correlationId: null, metadata: {}, type: "project.created",
      payload: { projectId, title: "Adoption fixture", workspaceRoot: thread.workspace, defaultModelSelection: null, scripts: [], createdAt: thread.createdAt, updatedAt: thread.updatedAt } } };
  const reply = writeEvents(dbPath, events, projectEvent);
  const projection = reply.projections?.[0];
  if (!projection?.records) throw new Error("Pinned EventSink did not return the native fixture projection.");
  return { dbPath, projectId, threadId, providerThreadId, events,
    ...(checkpointFixture ? { checkpoint: checkpointFixture.ids } : {}), target: {
    exists: true, thread: projection.snapshot.projection.thread, records: projection.records, threadId: projection.threadId,
  } };
}

/** Return pinned-schema EventSink rows for a completed operational checkpoint chain. */
function operationalCheckpointEvents(input: {
  threadId: string; providerThreadId: string; providerInstanceId: string; sourceNativeTurnId: string;
  providerTurnId: string; nodeId: string; userMessageId: string;
}): { ids: { runId: string; attemptId: string; scopeId: string; checkpointId: string; itemId: string }; beforeContinuationEvents: Array<Record<string, any>>; afterContinuationEvents: Array<Record<string, any>> } {
  const { threadId, providerThreadId, providerInstanceId, sourceNativeTurnId, providerTurnId, nodeId, userMessageId } = input;
  const stamp = "2026-10-12T13:00:00.000Z";
  const runId = `run:thread:${threadId}:ordinal:1`;
  const attemptId = `run-attempt:${runId}:attempt:1`;
  const scopeId = `checkpoint-scope:thread:${threadId}:name:root`;
  const checkpointId = `checkpoint:scope:${scopeId}:name:1`;
  const turnItem = `turn-item:provider:${providerInstanceId}:native-item:${encodeURIComponent(`checkpoint:${checkpointId}`)}`;
  const events: Array<Record<string, any>> = [
    { id: `operational:run:${runId}`, type: "run.created", threadId, providerInstanceId, occurredAt: stamp,
      payload: { id: runId, threadId, ordinal: 1, providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "fixture-model" }, providerThreadId,
        userMessageId, rootNodeId: nodeId, activeAttemptId: attemptId,
        status: "completed", checkpointId, contextHandoffId: null, requestedAt: stamp, startedAt: stamp, completedAt: stamp } },
    { id: `operational:attempt:${attemptId}`, type: "run-attempt.created", threadId, providerInstanceId, occurredAt: stamp,
      payload: { id: attemptId, threadId, runId, attemptOrdinal: 1, rootNodeId: nodeId, providerInstanceId, providerThreadId,
        providerTurnId, reason: "initial", status: "completed", startedAt: stamp, completedAt: stamp } },
    { id: `operational:node:${nodeId}`, type: "node.updated", threadId, providerInstanceId, occurredAt: stamp,
      payload: { id: nodeId, threadId, runId, parentNodeId: null, rootNodeId: nodeId, kind: "root_turn", status: "completed",
        countsForRun: true, providerThreadId, providerTurnId, nativeItemRef: null, runtimeRequestId: null,
        checkpointScopeId: scopeId, startedAt: stamp, completedAt: stamp, title: null } },
    { id: `operational:scope:${scopeId}`, type: "checkpoint-scope.created", threadId, providerInstanceId, occurredAt: stamp,
      payload: { id: scopeId, threadId, runId, nodeId, parentScopeId: null, providerThreadId, kind: "root_run", ordinalWithinParent: 1,
        advancesAppRunCount: true, cwd: "/fixture", createdAt: stamp } },
    { id: `operational:checkpoint:${checkpointId}`, type: "checkpoint.captured", threadId, providerInstanceId, occurredAt: stamp,
      payload: { id: checkpointId, threadId, scopeId, runId, nodeId, parentCheckpointId: null, ordinalWithinScope: 1,
        appRunOrdinal: 1, ref: `checkpoint-ref:${checkpointId}`, status: "missing", capturedAt: stamp, files: [] } },
    { id: `operational:checkpoint-item:${turnItem}`, type: "turn-item.updated", threadId, providerInstanceId, occurredAt: stamp,
      payload: { id: turnItem, threadId, runId, nodeId, providerThreadId, providerTurnId: null, nativeItemRef: null, parentItemId: null,
        ordinal: 999, type: "checkpoint", status: "completed", title: null, startedAt: stamp, completedAt: stamp, updatedAt: stamp,
        checkpointId, scopeId, files: [] } },
  ];
  return { ids: { runId, attemptId, scopeId, checkpointId, itemId: turnItem },
    beforeContinuationEvents: events.slice(0, 4), afterContinuationEvents: events.slice(4) };
}
