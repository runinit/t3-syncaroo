import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalConversation, canonicalThread } from "./helpers.js";
import { resolveTargetPaths } from "../src/target/config.js";
import { syncConversations } from "../src/target/sync.js";
import type { CanonicalThread } from "../src/core/types.js";
import { checkpointForThread } from "../src/core/checkpoint.js";
import { canonicalPath, sha256 } from "../src/core/util.js";
import { recordImports } from "../src/target/ledger.js";
import { captureNativeProjectionIdentity, encodeCanonicalHistory } from "../src/target/v2/history.js";

const fixtureDb = process.env.T3_V2_FIXTURE_DB;
const helper = fileURLToPath(new URL("../vendor/t3-v2-native-helper.mjs", import.meta.url));
const temporaryHomes: string[] = [];
const originalLedgerDir = process.env.T3_IMPORT_DATA_DIR;

afterEach(() => {
  for (const root of temporaryHomes.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalLedgerDir === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedgerDir;
});

function inspectNative(dbPath: string, threadId: string): { events: Array<{ id: string; sequence: number }>; records?: BuiltinImportProjection["records"] } {
  const reply = JSON.parse(execFileSync(process.execPath, [helper], {
    input: JSON.stringify({ op: "inspect", dbPath, threadIds: [threadId] }), encoding: "utf8",
  })) as { threads?: Array<{ events: Array<{ id: string; sequence: number }>; records?: BuiltinImportProjection["records"] }> };
  const thread = reply.threads?.[0];
  if (!thread) throw new Error("Pinned native helper did not return the imported thread.");
  return thread;
}

interface NativeWriteOptions { nativeSessionId?: string; nativeTurnId?: string; userNativeItemId?: string; foreignAssistantNativeTurnIndex?: number; extraActivity?: boolean; extraPlan?: boolean }

function nativeBuiltinWrite(root: string, thread: CanonicalThread, instance = "codex", options: NativeWriteOptions = {}): { dbPath: string; projectId: string; target: BuiltinImportProjection & { threadId: string }; events: Array<Record<string, any>> } {
  const dbPath = join(root, "userdata", "statev2.sqlite");
  const projectId = `project:adoption-${thread.sourceSessionId}`;
  const driver = instance;
  const threadId = `import:${instance}:${thread.sourceSessionId}`;
  const providerThreadId = `provider-thread:adoption-${thread.sourceSessionId}`;
  const createdAt = thread.createdAt;
  const updatedAt = thread.updatedAt;
  const base = (id: string, messageId: string, ordinal: number, type: string, at: string, fields: Record<string, unknown>) => ({
    id, threadId, runId: null, nodeId: null, providerThreadId: null, providerTurnId: null,
    nativeItemRef: null, parentItemId: null, ordinal, status: "completed", title: null,
    startedAt: at, completedAt: at, updatedAt: at, type, messageId, ...fields,
  });
  const events: Array<Record<string, unknown>> = [{
    id: `agent-session-import:v2:thread:${threadId}:created`, type: "thread.created", threadId,
    providerInstanceId: instance, occurredAt: createdAt,
    payload: {
      createdBy: "system", creationSource: "server", id: threadId, projectId, title: thread.title,
      providerInstanceId: instance, modelSelection: { instanceId: instance, model: thread.model },
      runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null,
      linkedPullRequest: null, branchPullRequest: null, activeProviderThreadId: providerThreadId,
      historyOrigin: "v1_import", lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null, createdAt, updatedAt, archivedAt: null, settledOverride: "settled", settledAt: updatedAt,
      unsettledAt: null, snoozedUntil: null, snoozedAt: null, pinnedAt: null, pinOrderKey: null,
      activeOrderKey: null, lastVisitedAt: null, deletedAt: null,
    },
  }];
  const messages = [thread.turns[0]!.user, ...thread.turns[0]!.assistant];
  messages.forEach((message, index) => {
    const suffix = String(index).padStart(6, "0");
    const id = `${threadId}:${suffix}`;
    const itemId = `agent-session-import:v2:turn-item:${threadId}:${suffix}`;
    const occurredAt = message.timestamp;
    events.push({
      id: `agent-session-import:v2:message:${threadId}:${suffix}`, type: "message.updated", threadId, occurredAt,
      payload: { createdBy: message.role === "user" ? "user" : "agent", creationSource: "server", id, threadId,
        runId: null, nodeId: null, role: message.role, text: message.text, attachments: [], streaming: false,
        createdAt: occurredAt, updatedAt: occurredAt },
    });
    const item = message.role === "user"
      ? base(itemId, id, index + 1, "user_message", occurredAt, { createdBy: "user", creationSource: "server", inputIntent: "turn_start", text: message.text, attachments: [] })
      : base(itemId, id, index + 1, "assistant_message", occurredAt, { text: message.text, streaming: false });
    events.push({ id: `agent-session-import:v2:turn-item:${threadId}:${suffix}`, type: "turn-item.updated", threadId, occurredAt, payload: item });
  });
  let continuationOrdinal = messages.length;
  for (const [turnIndex, turn] of thread.turns.slice(1).entries()) {
    const nativeProviderTurnId = `native-provider-turn:${thread.sourceSessionId}:${turnIndex + 1}`;
    const lastAssistantNode = /^(.*):text:\d+$/u.exec(turn.assistant.at(-1)?.sourceId ?? "")?.[1];
    const nativeTurnId = options.nativeTurnId ?? (driver === "claudeAgent" ? lastAssistantNode : turn.id);
    if (!nativeTurnId) throw new Error("Native continuation fixture has no source-backed turn identity.");
    events.push({
      id: `native-provider-event:${thread.sourceSessionId}:${turnIndex + 1}`, type: "provider-turn.updated", threadId,
      driver, providerInstanceId: instance, occurredAt: turn.completedAt ?? turn.startedAt,
      payload: { id: nativeProviderTurnId, providerThreadId, nodeId: `native-node:${nativeTurnId}`, runAttemptId: null,
        nativeTurnRef: { driver, nativeId: nativeTurnId, strength: driver === "claudeAgent" ? "weak" : "strong" }, ordinal: turnIndex + 1,
        status: turn.status, startedAt: turn.startedAt, completedAt: turn.completedAt ?? null },
    });
    for (const message of [turn.user, ...turn.assistant]) {
      continuationOrdinal++;
      const id = `native-message:${thread.sourceSessionId}:${message.sourceId}`;
      const itemId = `native-item:${thread.sourceSessionId}:${message.sourceId}`;
      const occurredAt = message.timestamp;
      events.push({
        id: `native-message-event:${thread.sourceSessionId}:${message.sourceId}`, type: "message.updated", threadId, occurredAt,
        payload: { createdBy: message.role === "user" ? "user" : "agent", creationSource: "server", id, threadId,
          runId: null, nodeId: null, role: message.role, text: message.text, attachments: [], streaming: false,
          createdAt: occurredAt, updatedAt: occurredAt },
      });
      const item = message.role === "user"
      ? base(itemId, id, continuationOrdinal, "user_message", occurredAt, { createdBy: "user", creationSource: "server", inputIntent: "turn_start", text: message.text, attachments: [], providerThreadId, providerTurnId: null,
          ...(options.userNativeItemId ? { nativeItemRef: { driver, nativeId: options.userNativeItemId, strength: "strong" } } : {}) })
        : base(itemId, id, continuationOrdinal, "assistant_message", occurredAt, { text: message.text, streaming: false, providerThreadId, providerTurnId: options.foreignAssistantNativeTurnIndex === turnIndex ? "foreign-provider-turn" : nativeProviderTurnId,
          nativeItemRef: { driver, nativeId: driver === "claudeAgent" ? /^(.*):text:\d+$/u.exec(message.sourceId)?.[1] : message.sourceId, strength: "strong" } });
      events.push({ id: `native-item-event:${thread.sourceSessionId}:${message.sourceId}`, type: "turn-item.updated", threadId, occurredAt, payload: item });
    }
  }
  if (thread.turns.length > 1 && (options.extraActivity || options.extraPlan)) {
    const augmented = structuredClone(thread);
    const lastTurn = augmented.turns.at(-1)!;
    if (options.extraActivity) lastTurn.activities.push({ sourceId: "native-unowned-activity", timestamp: lastTurn.completedAt ?? lastTurn.startedAt,
      tone: "info", kind: "reasoning.summary", summary: "Unowned activity", payload: { detail: "Extra activity" } });
    if (options.extraPlan) lastTurn.plans.push({ sourceId: "native-unowned-plan", timestamp: lastTurn.completedAt ?? lastTurn.startedAt, markdown: "Unowned plan" });
    const extraEvents = encodeCanonicalHistory(augmented, threadId, join(root, "userdata", "attachments"), [lastTurn]).events;
    if (options.extraActivity) {
      const item = extraEvents.find((event) => event.type === "turn-item.updated" && (event.payload as Record<string, unknown>).text === "Extra activity");
      if (item) events.push({ ...item, id: "native-unowned-activity-event", providerInstanceId: instance,
        payload: { ...(item.payload as Record<string, unknown>), id: "native-unowned-activity-item", providerThreadId,
          providerTurnId: `native-provider-turn:${thread.sourceSessionId}:${thread.turns.length - 1}` } });
    }
    if (options.extraPlan) {
      const plan = extraEvents.find((event) => event.type === "plan.updated" && String((event.payload as Record<string, unknown>).markdown).includes("Unowned plan"));
      if (plan) events.push({ ...plan, id: "native-unowned-plan-event", providerInstanceId: instance });
    }
  }
  events.push({
    id: `agent-session-import:v2:provider-thread:${providerThreadId}`, type: "provider-thread.updated", threadId,
    driver, providerInstanceId: instance, occurredAt: updatedAt,
    payload: { id: providerThreadId, driver, providerInstanceId: instance, providerSessionId: null, appThreadId: threadId,
      ownerNodeId: null, nativeThreadRef: { driver, nativeId: options.nativeSessionId ?? thread.sourceSessionId, strength: "strong" },
      nativeConversationHeadRef: null, status: "idle", firstRunOrdinal: null, lastRunOrdinal: null,
      handoffIds: [], forkedFrom: null, pendingBackgroundTasks: [], createdAt, updatedAt },
  });
  const projectEvent = {
    commandId: `command:adoption:${thread.sourceSessionId}`, commandType: "project.create", acceptedAt: createdAt,
    event: { sequence: 1, eventId: `event:adoption:${thread.sourceSessionId}:project`, aggregateKind: "project", aggregateId: projectId,
      occurredAt: createdAt, commandId: null, causationEventId: null, correlationId: null, metadata: {}, type: "project.created",
      payload: { projectId, title: "Adoption fixture", workspaceRoot: thread.workspace, defaultModelSelection: null, scripts: [], createdAt, updatedAt } },
  };
  const reply = JSON.parse(execFileSync(process.execPath, [helper], {
    input: JSON.stringify({ op: "write", dbPath, events, projectEvent }), encoding: "utf8",
  })) as { ok: boolean; projections?: Array<{ threadId: string; snapshot: { projection: { thread: Record<string, unknown> } }; records: Record<string, unknown> }> };
  const projection = reply.projections?.[0];
  if (!reply.ok || !projection?.records) throw new Error("Pinned native helper did not persist the built-in import fixture.");
  return { dbPath, projectId, events, target: {
    exists: true, thread: projection.snapshot.projection.thread,
    records: projection.records as NonNullable<BuiltinImportProjection["records"]>, threadId: projection.threadId,
  } };
}

interface BuiltinImportProjection {
  exists: boolean;
  thread?: Record<string, unknown> | null;
  records?: {
    messages?: Array<Record<string, unknown>>;
    turnItems?: Array<Record<string, unknown>>;
    plans?: Array<Record<string, unknown>>;
    providerTurns?: Array<Record<string, unknown>>;
    providerThreads?: Array<Record<string, unknown>>;
  };
}

describe.skipIf(!fixtureDb)("native provider continuation adoption", () => {
  it.each([
    ["exact native refs", {}, "synced"],
    ["foreign provider session", { nativeSessionId: "foreign-session" }, "history-diverged"],
    ["foreign provider turn", { nativeTurnId: "foreign-turn" }, "history-diverged"],
    ["foreign explicit user item ref", { userNativeItemId: "foreign-user-item" }, "history-diverged"],
    ["extra activity", { extraActivity: true }, "history-diverged"],
    ["extra plan", { extraPlan: true }, "history-diverged"],
  ] as const)("accepts Codex continuation only with %s", async (_case, nativeOptions, expectedStatus) => {
    const root = await mkdtemp(join(tmpdir(), "t3-adoption-native-codex-continuation-"));
    temporaryHomes.push(root);
    mkdirSync(join(root, "userdata"), { recursive: true });
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const dbPath = join(root, "userdata", "statev2.sqlite");
    copyFileSync(fixtureDb!, dbPath);
    const paths = resolveTargetPaths({ dbPath });
    const prefix = canonicalThread(workspace);
    prefix.turns[0]!.activities = [];
    const advanced = structuredClone(prefix);
    advanced.updatedAt = "2026-01-02T00:00:03.000Z";
    advanced.turns.push({
      id: "native-turn-2", startedAt: "2026-01-02T00:00:00.000Z", completedAt: "2026-01-02T00:00:03.000Z", status: "completed",
      user: { sourceId: "native-user-2", role: "user", text: "Continue", timestamp: "2026-01-02T00:00:00.000Z", attachments: [] },
      assistant: [{ sourceId: "native-assistant-2", role: "assistant", text: "Done", timestamp: "2026-01-02T00:00:02.000Z", attachments: [] }],
      activities: [], plans: [],
    });
    const persisted = nativeBuiltinWrite(root, advanced, "codex", nativeOptions);
    const projection = inspectNative(dbPath, persisted.target.threadId).records!;
    const checkpoint = checkpointForThread(prefix);
    if (checkpoint.version !== 2) throw new Error("Expected v2 source checkpoint");
    const nativeProjection = captureNativeProjectionIdentity({
      messages: projection.messages!.slice(0, 2), turnItems: projection.turnItems!.slice(0, 2), plans: [], providerTurns: [],
    });
    if (!nativeProjection) throw new Error("Expected a complete native projection checkpoint");
    checkpoint.nativeProjection = nativeProjection;
    const initialConversation = canonicalConversation(workspace, prefix);
    recordImports([{
      targetId: sha256(canonicalPath(dbPath)), source: prefix.source, sourceSessionId: prefix.sourceSessionId,
      sourceKey: prefix.sourceKey, sourceFingerprint: initialConversation.fingerprint,
      projectId: persisted.projectId, threadId: persisted.target.threadId,
      importedAt: prefix.createdAt, importerVersion: "0.4.1", migration: 61, firstSequence: 1,
      lastSequence: inspectNative(dbPath, persisted.target.threadId).events.length, resumable: true,
      backupPath: dbPath, warnings: [], identitySeed: prefix.sourceKey, currentSourceKey: prefix.sourceKey,
      sourceTitle: prefix.title, checkpoint, isCanonical: true,
    }]);
    const before = inspectNative(dbPath, persisted.target.threadId).events;

    const result = await syncConversations([{ conversation: canonicalConversation(workspace, advanced) }], paths, { dryRun: false });

    let expectedStoredEvents = before;
    if (expectedStatus === "synced") {
      expect(result.results[0]).toMatchObject({ status: "synced", threadId: persisted.target.threadId, turnsAdded: 0, turnsAdopted: 1, events: 0 });
      const next = structuredClone(advanced);
      next.updatedAt = "2026-01-03T00:00:03.000Z";
      next.turns.push({
        id: "native-turn-3", startedAt: "2026-01-03T00:00:00.000Z", completedAt: "2026-01-03T00:00:03.000Z", status: "completed",
        user: { sourceId: "native-user-3", role: "user", text: "Again", timestamp: "2026-01-03T00:00:00.000Z", attachments: [] },
        assistant: [{ sourceId: "native-assistant-3", role: "assistant", text: "Still done", timestamp: "2026-01-03T00:00:02.000Z", attachments: [] }],
        activities: [], plans: [],
      });
      const nextRoot = join(root, "next");
      mkdirSync(join(nextRoot, "userdata"), { recursive: true });
      copyFileSync(fixtureDb!, join(nextRoot, "userdata", "statev2.sqlite"));
      const nextWrite = nativeBuiltinWrite(nextRoot, next);
      // The second projection is a later native state with the same immutable
      // prefix and one additional provider turn; sync's checkpoint comes from
      // the first state and must recognize the retained provider-turn IDs.
      copyFileSync(nextWrite.dbPath, dbPath);
      expectedStoredEvents = inspectNative(dbPath, persisted.target.threadId).events;
      const twice = await syncConversations([{ conversation: canonicalConversation(workspace, next) }], paths, { dryRun: false });
      if (twice.results[0]?.status !== "synced") throw new Error(`Second native continuation did not reconcile: ${JSON.stringify(twice.results[0])}`);
      expect(twice.results[0]).toMatchObject({ status: "synced", threadId: persisted.target.threadId, turnsAdded: 0, turnsAdopted: 1, events: 0 });
    } else expect(result.results[0]?.status).toBe(expectedStatus);
    expect(inspectNative(dbPath, persisted.target.threadId).events).toEqual(expectedStoredEvents);
  });

  it("retains provider turn and item lineage for already adopted native prefixes", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-adoption-native-retained-lineage-"));
    temporaryHomes.push(root);
    mkdirSync(join(root, "userdata"), { recursive: true });
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const dbPath = join(root, "userdata", "statev2.sqlite");
    copyFileSync(fixtureDb!, dbPath);
    const paths = resolveTargetPaths({ dbPath });
    const prefix = canonicalThread(workspace);
    prefix.turns[0]!.activities = [];
    const advanced = structuredClone(prefix);
    advanced.updatedAt = "2026-01-02T00:00:03.000Z";
    advanced.turns.push({
      id: "native-turn-2", startedAt: "2026-01-02T00:00:00.000Z", completedAt: "2026-01-02T00:00:03.000Z", status: "completed",
      user: { sourceId: "native-user-2", role: "user", text: "Continue", timestamp: "2026-01-02T00:00:00.000Z", attachments: [] },
      assistant: [{ sourceId: "native-assistant-2", role: "assistant", text: "Done", timestamp: "2026-01-02T00:00:02.000Z", attachments: [] }],
      activities: [], plans: [],
    });
    const persisted = nativeBuiltinWrite(root, advanced);
    const projection = inspectNative(dbPath, persisted.target.threadId).records!;
    const checkpoint = checkpointForThread(prefix);
    if (checkpoint.version !== 2) throw new Error("Expected v2 source checkpoint");
    const nativeProjection = captureNativeProjectionIdentity({
      messages: projection.messages!.slice(0, 2), turnItems: projection.turnItems!.slice(0, 2), plans: [], providerTurns: [],
    });
    if (!nativeProjection) throw new Error("Expected a complete native projection checkpoint");
    checkpoint.nativeProjection = nativeProjection;
    const initial = canonicalConversation(workspace, prefix);
    recordImports([{
      targetId: sha256(canonicalPath(dbPath)), source: prefix.source, sourceSessionId: prefix.sourceSessionId,
      sourceKey: prefix.sourceKey, sourceFingerprint: initial.fingerprint, projectId: persisted.projectId,
      threadId: persisted.target.threadId, importedAt: prefix.createdAt, importerVersion: "0.4.1", migration: 61,
      firstSequence: 1, lastSequence: inspectNative(dbPath, persisted.target.threadId).events.length, resumable: true,
      backupPath: dbPath, warnings: [], identitySeed: prefix.sourceKey, currentSourceKey: prefix.sourceKey,
      sourceTitle: prefix.title, checkpoint, isCanonical: true,
    }]);
    const adopted = await syncConversations([{ conversation: canonicalConversation(workspace, advanced) }], paths, { dryRun: false });
    expect(adopted.results[0]).toMatchObject({ status: "synced", turnsAdopted: 1 });

    const later = structuredClone(advanced);
    later.updatedAt = "2026-01-03T00:00:03.000Z";
    later.turns.push({
      id: "native-turn-3", startedAt: "2026-01-03T00:00:00.000Z", completedAt: "2026-01-03T00:00:03.000Z", status: "completed",
      user: { sourceId: "native-user-3", role: "user", text: "Again", timestamp: "2026-01-03T00:00:00.000Z", attachments: [] },
      assistant: [{ sourceId: "native-assistant-3", role: "assistant", text: "Still done", timestamp: "2026-01-03T00:00:02.000Z", attachments: [] }],
      activities: [], plans: [],
    });
    const laterRoot = join(root, "later");
    mkdirSync(join(laterRoot, "userdata"), { recursive: true });
    copyFileSync(fixtureDb!, join(laterRoot, "userdata", "statev2.sqlite"));
    const changed = nativeBuiltinWrite(laterRoot, later, "codex", { foreignAssistantNativeTurnIndex: 0 });
    copyFileSync(changed.dbPath, dbPath);
    const before = inspectNative(dbPath, persisted.target.threadId).events;
    const result = await syncConversations([{ conversation: canonicalConversation(workspace, later) }], paths, { dryRun: false });
    expect(result.results[0]?.status).toBe("history-diverged");
    expect(inspectNative(dbPath, persisted.target.threadId).events).toEqual(before);
  });

  it("adopts a completed Claude continuation with a null native head only through exact node and item lineage", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-adoption-native-claude-continuation-"));
    temporaryHomes.push(root);
    mkdirSync(join(root, "userdata"), { recursive: true });
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
    const dbPath = join(root, "userdata", "statev2.sqlite");
    copyFileSync(fixtureDb!, dbPath);
    const paths = resolveTargetPaths({ dbPath });
    const prefix = canonicalThread(workspace);
    prefix.source = "claude";
    prefix.sourceSessionId = "00000000-0000-4000-8000-000000000001";
    prefix.sourceKey = `claude:${prefix.sourceSessionId}:00000000-0000-4000-8000-000000000011`;
    prefix.currentBranch = true;
    prefix.leafId = "00000000-0000-4000-8000-000000000011";
    prefix.turns[0]!.id = "00000000-0000-4000-8000-000000000011";
    prefix.turns[0]!.user.sourceId = "00000000-0000-4000-8000-000000000011";
    prefix.turns[0]!.assistant[0]!.sourceId = "00000000-0000-4000-8000-000000000012:text:0";
    prefix.resumeCursor = { resume: prefix.sourceSessionId, resumeSessionAt: "00000000-0000-4000-8000-000000000012", turnCount: 1 };
    prefix.turns[0]!.activities = [];
    const advanced = structuredClone(prefix);
    advanced.updatedAt = "2026-01-02T00:00:03.000Z";
    const userId = "00000000-0000-4000-8000-000000000021";
    const assistantId = "00000000-0000-4000-8000-000000000022";
    advanced.leafId = assistantId;
    advanced.sourceKey = `claude:${prefix.sourceSessionId}:${assistantId}`;
    advanced.resumeCursor = { resume: prefix.sourceSessionId, resumeSessionAt: assistantId, turnCount: 2 };
    advanced.turns.push({
      id: userId, startedAt: "2026-01-02T00:00:00.000Z", completedAt: "2026-01-02T00:00:03.000Z", status: "completed",
      user: { sourceId: userId, role: "user", text: "Continue", timestamp: "2026-01-02T00:00:00.000Z", attachments: [] },
      assistant: [{ sourceId: `${assistantId}:text:0`, role: "assistant", text: "Done", timestamp: "2026-01-02T00:00:02.000Z", attachments: [] }],
      activities: [], plans: [],
    });
    const persisted = nativeBuiltinWrite(root, advanced, "claudeAgent", { userNativeItemId: userId });
    const projection = inspectNative(dbPath, persisted.target.threadId).records!;
    const checkpoint = checkpointForThread(prefix);
    if (checkpoint.version !== 2) throw new Error("Expected v2 source checkpoint");
    const nativeProjection = captureNativeProjectionIdentity({
      messages: projection.messages!.slice(0, 2), turnItems: projection.turnItems!.slice(0, 2), plans: [], providerTurns: [],
    });
    if (!nativeProjection) throw new Error("Expected a complete native projection checkpoint");
    checkpoint.nativeProjection = nativeProjection;
    const initialConversation = canonicalConversation(workspace, prefix);
    recordImports([{
      targetId: sha256(canonicalPath(dbPath)), source: prefix.source, sourceSessionId: prefix.sourceSessionId,
      sourceKey: prefix.sourceKey, sourceFingerprint: initialConversation.fingerprint,
      projectId: persisted.projectId, threadId: persisted.target.threadId,
      importedAt: prefix.createdAt, importerVersion: "0.4.1", migration: 61, firstSequence: 1,
      lastSequence: inspectNative(dbPath, persisted.target.threadId).events.length, resumable: true,
      backupPath: dbPath, warnings: [], identitySeed: prefix.sourceKey, currentSourceKey: prefix.sourceKey,
      sourceTitle: prefix.title, nativeConversationHeadId: String(prefix.resumeCursor?.resumeSessionAt), checkpoint, isCanonical: true,
    }]);
    const before = inspectNative(dbPath, persisted.target.threadId).events;
    const advancedConversation = canonicalConversation(workspace, advanced);
    const synced = await syncConversations([{ conversation: advancedConversation }], paths, { dryRun: false });
    expect(synced.results[0]).toMatchObject({ status: "synced", threadId: persisted.target.threadId, turnsAdded: 0, turnsAdopted: 1, events: 0 });
    expect(inspectNative(dbPath, persisted.target.threadId).events).toEqual(before);
  });

});
