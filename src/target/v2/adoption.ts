import type { CanonicalThread } from "../../core/types.js";
import { deterministicUuid, canonicalPath } from "../../core/util.js";
import { encodeCanonicalHistory, projectedHistoryMatches } from "./history.js";

type NativeRef = { driver?: string; nativeId?: string; strength?: string } | null;

export interface BuiltinImportProjection {
  exists: boolean;
  events?: Array<{
    id: string;
    sequence: number;
    type?: string;
    threadId?: string;
    aggregateKind?: string;
    aggregateId?: string;
    occurredAt?: string;
    driver?: string;
    providerInstanceId?: string;
    payload?: Record<string, unknown>;
  }>;
  thread?: {
    id?: string;
    projectId?: string;
    historyOrigin?: string;
    providerInstanceId?: string;
    activeProviderThreadId?: string;
  } | null;
  records?: {
    thread?: BuiltinImportProjection["thread"];
    messages?: Array<{ id?: string; threadId?: string; role: string; text: string; attachments?: Array<Record<string, unknown>> }>;
    turnItems?: Array<Record<string, unknown>>;
    plans?: Array<Record<string, unknown>>;
    providerTurns?: Array<Record<string, unknown>>;
    providerThreads?: Array<{
      id: string;
      appThreadId?: string;
      driver?: string;
      providerInstanceId?: string;
      nativeThreadRef?: NativeRef;
      nativeConversationHeadRef?: NativeRef;
      [key: string]: unknown;
    }>;
  };
}

export interface BuiltinProjectReference {
  id: string;
  workspaceRoot: string;
}

export type BuiltinAdoptionResult =
  | { status: "match"; threadId: string; providerThreadId: string; providerConversationHeadEvent?: Record<string, unknown> }
  | { status: "conflict"; reason: string };

export function builtinHeadAttachmentEventId(providerInstanceId: string, sourceSessionId: string, sourceKey: string, headId: string): string {
  return deterministicUuid(`t3-import:adopt-built-in-head:${providerInstanceId}:${sourceSessionId}:${sourceKey}:${headId}`);
}

function conflict(reason: string): BuiltinAdoptionResult {
  return { status: "conflict", reason };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function driverFor(source: CanonicalThread["source"]): "codex" | "claudeAgent" {
  return source === "codex" ? "codex" : "claudeAgent";
}

function supportsBuiltinTextHistory(thread: CanonicalThread): boolean {
  return thread.turns.length > 0
    && (thread.ignoredInProgressTurns ?? 0) === 0
    && thread.turns.every((turn) => turn.status === "completed"
      && turn.activities.length === 0
      && turn.plans.length === 0
      && turn.user.attachments.length === 0
      && turn.assistant.every((message) => message.attachments.length === 0));
}

/**
 * Verify whether a discovered source session is exactly represented by T3's
 * text-only built-in import. This is a read-only predicate; callers persist
 * ownership only after it returns a match.
 */
export function matchBuiltinImport(input: {
  thread: CanonicalThread;
  sourceCandidates: CanonicalThread[];
  providerInstanceId: string;
  project: BuiltinProjectReference;
  target: BuiltinImportProjection;
  attachmentsDir: string;
}): BuiltinAdoptionResult {
  const { thread, target, project, providerInstanceId } = input;
  const driver = driverFor(thread.source);
  const threadId = `import:${providerInstanceId}:${thread.sourceSessionId}`;
  const projected = target.records?.thread ?? target.thread;
  if (!target.exists || !projected || projected.id !== threadId) return conflict("No built-in import with the exact provider-instance and source-session identity was found.");
  if (projected.projectId !== project.id || canonicalPath(thread.workspace) !== canonicalPath(project.workspaceRoot)) {
    return conflict("The built-in task belongs to a different project or source workspace.");
  }
  if (projected.providerInstanceId !== providerInstanceId || projected.historyOrigin !== "v1_import") {
    return conflict("The built-in task does not have the expected provider instance and import origin.");
  }

  const providers = target.records?.providerThreads ?? [];
  const activeId = projected.activeProviderThreadId;
  if (typeof activeId !== "string" || activeId.length === 0) return conflict("The built-in task has no active provider-thread reference.");
  const bindings = providers.filter((binding) => binding.appThreadId === threadId
    && binding.id === activeId);
  if (bindings.length !== 1) return conflict("The built-in task has a missing or ambiguous active provider binding.");
  const binding = bindings[0]!;
  const expectedNativeId = thread.source === "codex"
    ? String(thread.resumeCursor?.threadId ?? thread.sourceSessionId)
    : thread.sourceSessionId;
  if (binding.id !== activeId || binding.driver !== driver || binding.providerInstanceId !== providerInstanceId
    || binding.nativeThreadRef?.driver !== driver || binding.nativeThreadRef.strength !== "strong"
    || binding.nativeThreadRef.nativeId !== expectedNativeId) {
    return conflict("The built-in provider binding does not identify this exact strong source session.");
  }

  if (thread.source === "claude") {
    const sameSessionCandidates = input.sourceCandidates.filter((candidate) => candidate.sourceSessionId === thread.sourceSessionId);
    if (!thread.currentBranch || !thread.leafId || sameSessionCandidates.length !== 1 || sameSessionCandidates[0]?.sourceKey !== thread.sourceKey) {
      return conflict("Claude source branch identity is ambiguous; select one uniquely identified current branch before adoption.");
    }
    if (typeof thread.resumeCursor?.resumeSessionAt !== "string" || !thread.resumeCursor.resumeSessionAt) {
      return conflict("The Claude source has no exact assistant head to attach; adoption cannot preserve continuation.");
    }
    const lastAssistantSourceId = thread.turns.at(-1)?.assistant.at(-1)?.sourceId ?? "";
    const lastAssistantNodeId = /^(.*):text:\d+$/u.exec(lastAssistantSourceId)?.[1];
    if (!lastAssistantNodeId || lastAssistantNodeId !== thread.resumeCursor.resumeSessionAt) {
      return conflict("The Claude source head does not match the last assistant node in the selected lineage.");
    }
    // The only safe retry after a prior attach is one whose deterministic
    // ownership event is still present. A matching head by itself is not
    // sufficient evidence: another writer may have attached it.
  } else if (binding.nativeConversationHeadRef !== null) {
    return conflict("The built-in Codex task has an unexpected conversation head.");
  }

  if (!supportsBuiltinTextHistory(thread)) {
    return conflict("The source contains plans, activity, images, incomplete turns, or other history omitted by T3's text-only built-in importer.");
  }
  const history = encodeCanonicalHistory(thread, threadId, input.attachmentsDir);
  const messages = target.records?.messages;
  if (!messages || messages.length !== history.messages.length
    || !messages.every((message, index) => message.id && message.threadId === threadId
      && message.role === history.messages[index]?.role
      && message.text === history.messages[index]?.text
      && (message.attachments ?? []).length === 0)) {
    return conflict("The built-in task's complete message history differs from the current source transcript.");
  }
  const records = target.records;
  if (!records?.turnItems || !records.plans || !records.providerTurns || records.providerTurns.length !== 0
    || !projectedHistoryMatches(records, history.events, { identity: "semantic" })) {
    return conflict("The built-in task has missing, extra, or changed turn items, plans, or provider turns.");
  }
  const messageItems = records.turnItems.filter((item) => item.type === "user_message" || item.type === "assistant_message");
  if (messageItems.length !== messages.length || !messageItems.every((item, index) =>
    item.messageId === messages[index]?.id && item.text === messages[index]?.text)) {
    return conflict("The built-in turn items do not reference their corresponding projected messages.");
  }
  const sourceMessages = thread.turns.flatMap((turn) => [turn.user, ...turn.assistant]);
  for (let index = 0; index < messageItems.length; index++) {
    const ref = messageItems[index]?.nativeItemRef as NativeRef | undefined;
    if (ref == null) continue;
    const sourceId = sourceMessages[index]?.sourceId ?? "";
    const nativeId = thread.source === "claude" && sourceMessages[index]?.role === "assistant"
      ? /^(.*):text:\d+$/u.exec(sourceId)?.[1]
      : sourceId;
    if (!nativeId || ref.driver !== driver || ref.strength !== "strong" || ref.nativeId !== nativeId) {
      return conflict("A built-in turn item references a different native source item.");
    }
  }

  if (thread.source === "claude") {
    const headId = String(thread.resumeCursor!.resumeSessionAt);
    const head = { driver, nativeId: headId, strength: "strong" };
    const headEventId = builtinHeadAttachmentEventId(providerInstanceId, thread.sourceSessionId, thread.sourceKey, headId);
    const ownedAttach = target.events?.find((event) => event.id === headEventId);
    const attachedPayload = ownedAttach?.payload;
    const expectedPayload = { ...binding, nativeConversationHeadRef: head, updatedAt: thread.updatedAt };
    const payloadPreservesBinding = Boolean(attachedPayload) && stableJson(attachedPayload) === stableJson(expectedPayload);
    const alreadyAttached = binding.nativeConversationHeadRef?.driver === driver
      && binding.nativeConversationHeadRef.nativeId === headId
      && binding.nativeConversationHeadRef.strength === "strong"
      && ownedAttach?.type === "provider-thread.updated"
      && ownedAttach.threadId === threadId
      && ownedAttach.driver === driver
      && ownedAttach.providerInstanceId === providerInstanceId
      && ownedAttach.occurredAt === thread.updatedAt
      && attachedPayload?.id === binding.id
      && attachedPayload.appThreadId === threadId
      && attachedPayload.driver === driver
      && attachedPayload.providerInstanceId === providerInstanceId
      && payloadPreservesBinding
      && JSON.stringify(attachedPayload.nativeConversationHeadRef) === JSON.stringify(head)
      && attachedPayload.updatedAt === thread.updatedAt;
    if (ownedAttach && !alreadyAttached) {
      return conflict("The deterministic Claude head event ID is already stored with a different event envelope or payload.");
    }
    if (binding.nativeConversationHeadRef !== null && !alreadyAttached) {
      return conflict("The built-in Claude task already has a conversation head without this import's exact attachment event.");
    }
    if (alreadyAttached) return { status: "match", threadId, providerThreadId: binding.id };
    const providerConversationHeadEvent = {
      id: headEventId,
      type: "provider-thread.updated",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: thread.updatedAt,
      payload: { ...binding, nativeConversationHeadRef: head, updatedAt: thread.updatedAt },
    };
    return { status: "match", threadId, providerThreadId: binding.id, providerConversationHeadEvent };
  }
  return { status: "match", threadId, providerThreadId: binding.id };
}
