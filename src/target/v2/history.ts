import { basename, extname, join } from "node:path";
import type { CanonicalActivity, CanonicalMessage, CanonicalThread, CanonicalTurn } from "../../core/types.js";
import type { NativeProjectionIdentityV1 } from "../../core/checkpoint.js";
import { deterministicUuid, truncate } from "../../core/util.js";

export interface V2HistoryAsset {
  descriptor: { type: "image"; id: string; name: string; mimeType: string; sizeBytes: number };
  data?: Buffer;
  sourcePath?: string;
  finalPath: string;
}

export interface EncodedV2History {
  events: Array<Record<string, unknown>>;
  messages: Array<{ role: string; text: string }>;
  assets: V2HistoryAsset[];
  warnings: string[];
  activities: number;
}

type ProjectedHistoryRecords = {
  messages?: Array<Record<string, unknown>>;
  turnItems?: Array<Record<string, unknown>>;
  plans?: Array<Record<string, unknown>>;
  providerTurns?: Array<Record<string, unknown>>;
};

/** Capture target row identities after the caller has verified semantic history and ownership. */
export function captureNativeProjectionIdentity(records: ProjectedHistoryRecords | undefined): NativeProjectionIdentityV1 | undefined {
  if (!records?.messages || !records.turnItems || !records.plans) return undefined;
  const ids = [records.messages, records.turnItems, records.plans].map((rows) => rows.map((row) => row.id));
  if (ids[0]?.length === 0 || ids[1]?.length === 0 || !ids.every((items) => items.every((id) => typeof id === "string" && id.length > 0)
    && new Set(items).size === items.length)) return undefined;
  let providerTurns: string[] | undefined;
  if (records.providerTurns) {
    providerTurns = records.providerTurns.map((row) => row.id as string);
    if (!providerTurns.every((id) => typeof id === "string" && id.length > 0) || new Set(providerTurns).size !== providerTurns.length) return undefined;
  }
  const turnItemBindings = records.turnItems.map((row) => ({
    providerThreadId: typeof row.providerThreadId === "string" ? row.providerThreadId : null,
    providerTurnId: typeof row.providerTurnId === "string" ? row.providerTurnId : null,
    nativeItemRef: row.nativeItemRef && typeof row.nativeItemRef === "object" ? row.nativeItemRef : null,
  }));
  return { kind: "semantic-native-prefix-v1", messages: ids[0] as string[], turnItems: ids[1] as string[], plans: ids[2] as string[], ...(providerTurns ? { providerTurns } : {}), turnItemBindings };
}

/** Require the verified stored identities to remain the ordered prefix of projected history. */
export function nativeProjectionIdentityMatches(records: ProjectedHistoryRecords | undefined, identity: NativeProjectionIdentityV1): boolean {
  if (!records?.messages || !records.turnItems || !records.plans) return false;
  const actualIds = [records.messages, records.turnItems, records.plans].map((rows) => rows.map((row) => row.id));
  const visible = [identity.messages, identity.turnItems, identity.plans].every((expected, index) =>
    expected.every((id, rowIndex) => actualIds[index]?.[rowIndex] === id));
  if (!visible) return false;
  if (identity.turnItemBindings) {
    if (identity.turnItemBindings.length > (records.turnItems?.length ?? 0)
      || !identity.turnItemBindings.every((expected, index) => {
        const actual = records.turnItems?.[index];
        return (actual?.providerThreadId ?? null) === expected.providerThreadId
          && (actual?.providerTurnId ?? null) === expected.providerTurnId
          && sameProjectedValue(actual?.nativeItemRef ?? null, expected.nativeItemRef);
      })) return false;
  }
  if (identity.providerTurns) {
    if (!records.providerTurns || !identity.providerTurns.every((id, index) => records.providerTurns?.[index]?.id === id)) return false;
  }
  return true;
}

function sameProjectedValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Compare semantic projected history without requiring the source event IDs to match. */
export function projectedHistoryMatches(
  records: ProjectedHistoryRecords | undefined,
  expectedEvents: Array<Record<string, unknown>>,
  options: { identity?: "exact" | "semantic" | "native-semantic" } = {},
): boolean {
  if (!records?.messages || !records.turnItems || !records.plans) return false;
  const expectedMessages = expectedEvents
    .filter((event) => event.type === "message.updated")
    .map((event) => event.payload as Record<string, unknown>);
  if (records.messages.length !== expectedMessages.length) return false;
  if (options.identity === "semantic" || options.identity === "native-semantic") {
    const ignoredMessageIdentityFields = new Set(options.identity === "native-semantic"
      ? ["id", "threadId", "runId", "nodeId"]
      : ["id", "threadId"]);
    if (!expectedMessages.every((expected, index) => {
      const actual = records.messages![index];
      return Boolean(actual && Object.entries(expected).every(([key, item]) =>
        ignoredMessageIdentityFields.has(key) || sameProjectedValue(actual[key], item)));
    })) return false;
  } else {
    const actualMessages = new Map(records.messages.map((message) => [message.id, message]));
    if (!expectedMessages.every((expected) => {
      const actual = actualMessages.get(expected.id);
      return Boolean(actual && Object.entries(expected).every(([key, item]) => sameProjectedValue(actual[key], item)));
    })) return false;
  }
  const expectedItems = expectedEvents
    .filter((event) => event.type === "turn-item.updated")
    .map((event) => event.payload as Record<string, unknown>);
  if (records.turnItems.length !== expectedItems.length) return false;
  if (options.identity === "semantic" || options.identity === "native-semantic") {
    const actualItems = records.turnItems;
    const identityFields = new Set(options.identity === "native-semantic"
      ? ["id", "threadId", "messageId", "ordinal", "runId", "nodeId", "providerThreadId", "providerTurnId", "nativeItemRef", "parentItemId"]
      : ["id", "threadId", "messageId", "ordinal"]);
    const itemsMatch = expectedItems.every((expected, index) => {
      const actual = actualItems[index];
      return Boolean(actual && Object.entries(expected).every(([key, item]) =>
        identityFields.has(key) || sameProjectedValue(actual[key], item)));
    });
    if (!itemsMatch) return false;
    const expectedPlans = expectedEvents
      .filter((event) => event.type === "plan.updated")
      .map((event) => event.payload as Record<string, unknown>);
    if (records.plans.length !== expectedPlans.length) return false;
    const planIdentityFields = new Set(options.identity === "native-semantic"
      ? ["id", "threadId", "nodeId", "runId"]
      : ["id", "threadId", "nodeId"]);
    return expectedPlans.every((expected, index) => {
      const actual = records.plans![index];
      return Boolean(actual && Object.entries(expected).every(([key, item]) =>
        planIdentityFields.has(key) || sameProjectedValue(actual[key], item)));
    });
  }
  const actualItems = new Map(records.turnItems.map((item) => [item.id, item]));
  for (const expected of expectedItems) {
    const actual = actualItems.get(expected.id);
    if (!actual) return false;
    for (const [key, item] of Object.entries(expected)) {
      if (key === "ordinal") continue;
      if (!sameProjectedValue(actual[key], item)) return false;
    }
  }
  const expectedPlans = expectedEvents
    .filter((event) => event.type === "plan.updated")
    .map((event) => event.payload as Record<string, unknown>);
  if (records.plans.length !== expectedPlans.length) return false;
  const actualPlans = new Map(records.plans.map((item) => [item.id, item]));
  return expectedPlans.every((expected) => {
    const actual = actualPlans.get(expected.id);
    return Boolean(actual && Object.entries(expected).every(([key, item]) => sameProjectedValue(actual[key], item)));
  });
}

const extensionByMime: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return { type: "buffer", base64: value.toString("base64") };
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, jsonValue(nested)]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(jsonValue(value)); }
  catch { return String(value); }
}

function sourceItem(activity: CanonicalActivity): Record<string, unknown> {
  const data = activity.payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const item = (data as Record<string, unknown>).item;
  return item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
}

function safeImageId(threadId: string, sourceId: string): string {
  const segment = threadId.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/-+/gu, "-").replace(/^[-_]+|[-_]+$/gu, "").slice(0, 80).replace(/[-_]+$/gu, "") || "thread";
  return `${segment}-${deterministicUuid(`t3-import:attachment:${threadId}:${sourceId}`)}`;
}

function safeImageName(name: string, extension: string): string {
  const clean = basename(name).replace(/[\u0000-\u001f]/gu, "").slice(0, 240) || "image";
  return extname(clean) ? clean : `${clean}${extension}`;
}

function attachmentPlan(message: CanonicalMessage, threadId: string, attachmentsDir: string, warnings: string[]): { descriptors: Array<V2HistoryAsset["descriptor"]>; assets: V2HistoryAsset[]; notes: string[] } {
  const descriptors: Array<V2HistoryAsset["descriptor"]> = [];
  const assets: V2HistoryAsset[] = [];
  const notes: string[] = [];
  for (const attachment of message.attachments.slice(0, 8)) {
    const extension = extensionByMime[attachment.mimeType];
    if (!extension || attachment.sizeBytes > 10 * 1024 * 1024 || attachment.remoteUrl) {
      const reason = attachment.remoteUrl ? "remote images are not downloaded" : !extension ? `unsupported MIME type ${attachment.mimeType}` : "image exceeds 10 MB";
      warnings.push(`Skipped ${attachment.name}: ${reason}.`);
      notes.push(`[Attachment not imported: ${attachment.remoteUrl ?? attachment.name}]`);
      continue;
    }
    const id = safeImageId(threadId, attachment.sourceId);
    const descriptor = { type: "image" as const, id, name: safeImageName(attachment.name, extension), mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes };
    descriptors.push(descriptor);
    assets.push({ descriptor, ...(attachment.data ? { data: attachment.data } : {}), ...(attachment.path ? { sourcePath: attachment.path } : {}), finalPath: join(attachmentsDir, `${id}${extension}`) });
  }
  if (message.attachments.length > 8) warnings.push(`Message ${message.sourceId} has more than eight images; extras were skipped.`);
  return { descriptors, assets, notes };
}

function nativeStatus(status: CanonicalTurn["status"]): "completed" | "failed" | "interrupted" {
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  return "completed";
}

function itemBase(threadId: string, id: string, ordinal: number, at: string, status: string): Record<string, unknown> {
  return {
    id, threadId, runId: null, nodeId: null, providerThreadId: null, providerTurnId: null,
    nativeItemRef: null, parentItemId: null, ordinal, status, title: null,
    startedAt: at, completedAt: at, updatedAt: at,
  };
}

function event(thread: CanonicalThread, threadId: string, id: string, type: string, at: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { id: deterministicUuid(`t3-import:v2:event:${thread.sourceKey}:${id}`), type, threadId, driver: thread.source === "claude" ? "claudeAgent" : "codex", occurredAt: at, payload };
}

function timelineItem(thread: CanonicalThread, threadId: string, sourceId: string, at: string, ordinal: number, status: string, type: string, fields: Record<string, unknown>): Record<string, unknown> {
  const id = deterministicUuid(`t3-import:v2:turn-item:${thread.sourceKey}:${sourceId}`);
  return event(thread, threadId, `item:${sourceId}`, "turn-item.updated", at, { ...itemBase(threadId, id, ordinal, at, status), type, ...fields });
}

function planEvents(thread: CanonicalThread, threadId: string, sourceId: string, at: string, ordinal: number, kind: "proposed_plan" | "todo_list", body: Record<string, unknown>): Record<string, unknown>[] {
  const planId = deterministicUuid(`t3-import:v2:plan:${thread.sourceKey}:${sourceId}`);
  const nodeId = deterministicUuid(`t3-import:v2:node:${thread.sourceKey}:${sourceId}`);
  const status = kind === "todo_list" && Array.isArray(body.steps)
    && (body.steps as Array<{ status?: unknown }>).some((step) => step.status !== "completed") ? "active" : "completed";
  const artifact = { id: planId, threadId, runId: null, nodeId, status, kind, ...body };
  const fields = kind === "proposed_plan"
    ? { planId, markdown: body.markdown, streaming: false }
    : { planId, steps: body.steps, ...(body.explanation ? { explanation: body.explanation } : {}) };
  return [
    event(thread, threadId, `plan:${sourceId}`, "plan.updated", at, artifact),
    timelineItem(thread, threadId, sourceId, at, ordinal, "completed", kind, fields),
  ];
}

function planSteps(value: unknown): Array<{ id: string; text: string; status: "pending" | "running" | "completed" }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const row = raw as Record<string, unknown>;
    const text = stringValue(row.step) ?? stringValue(row.text) ?? stringValue(row.title);
    if (!text?.trim()) return [];
    const status = row.status === "completed" ? "completed" : row.status === "inProgress" || row.status === "running" ? "running" : "pending";
    return [{ id: `step-${index + 1}`, text, status }];
  });
}

function errorText(value: unknown): string {
  const raw = stringify(value).trim() || "The source provider reported an error.";
  const redacted = raw
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]");
  return truncate(redacted, 4_096) || "The source provider reported an error.";
}

function usageSnapshot(activity: CanonicalActivity, source: "codex" | "claude"): string | undefined {
  const values = activity.payload;
  const counts = Object.entries(values).filter(([, value]) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  if (counts.length === 0) return undefined;
  return `Historical ${source} token usage (${activity.timestamp}): ${counts.map(([key, value]) => `${key}=${value}`).join(", ")}.`;
}

function activityEvents(thread: CanonicalThread, threadId: string, activity: CanonicalActivity, ordinal: number): Record<string, unknown>[] {
  const common = { sourceId: activity.sourceId, timestamp: activity.timestamp };
  const status = activity.payload.status === "failed" || activity.tone === "error" ? "failed" : "completed";
  if (activity.kind === "reasoning.summary") {
    return [timelineItem(thread, threadId, common.sourceId, common.timestamp, ordinal, status, "reasoning", { text: stringify(activity.payload.detail ?? activity.summary), streaming: false })];
  }
  if (activity.kind === "turn.plan.updated") {
    const steps = planSteps(activity.payload.plan);
    if (steps.length) return planEvents(thread, threadId, common.sourceId, common.timestamp, ordinal, "todo_list", { steps, ...(stringValue(activity.payload.explanation) ? { explanation: activity.payload.explanation } : {}) });
  }
  if (activity.kind === "context-compaction") {
    return [timelineItem(thread, threadId, common.sourceId, common.timestamp, ordinal, status, "compaction", {
      driver: thread.source === "claude" ? "claudeAgent" : "codex", ...(stringValue(activity.payload.summary) ? { summary: activity.payload.summary } : { summary: activity.summary }),
      ...(Number.isSafeInteger(activity.payload.beforeTokenCount) && Number(activity.payload.beforeTokenCount) >= 0 ? { beforeTokenCount: activity.payload.beforeTokenCount } : {}),
      ...(Number.isSafeInteger(activity.payload.afterTokenCount) && Number(activity.payload.afterTokenCount) >= 0 ? { afterTokenCount: activity.payload.afterTokenCount } : {}),
    })];
  }
  if (activity.kind === "tool.completed") {
    const item = sourceItem(activity);
    const input = item.input ?? item.arguments ?? item.command ?? {};
    const output = item.output ?? activity.payload.detail;
    const itemType = activity.payload.itemType;
    if (itemType === "command_execution") {
      return [timelineItem(thread, threadId, common.sourceId, common.timestamp, ordinal, status, "command_execution", {
        input: stringify(input), ...(output !== undefined ? { output: stringify(output) } : {}),
        ...(status === "failed" ? { outputIndicatesFailure: true } : {}),
      })];
    }
    if (itemType === "web_search") {
      const query = stringValue(item.query) ?? stringValue(item.search_query);
      return [timelineItem(thread, threadId, common.sourceId, common.timestamp, ordinal, status, "web_search", {
        ...(query ? { patterns: [query] } : {}), ...(output !== undefined ? { results: Array.isArray(item.results) ? item.results : [] } : {}),
      })];
    }
    const toolName = stringValue(item.name) ?? stringValue(activity.payload.title) ?? activity.summary;
    return [timelineItem(thread, threadId, common.sourceId, common.timestamp, ordinal, status, "dynamic_tool", {
      toolName, input: jsonValue(input), ...(output !== undefined ? { output: jsonValue(output) } : {}),
    })];
  }
  if (activity.kind === "provider.error" || activity.kind.includes("error") || activity.tone === "error") {
    return [timelineItem(thread, threadId, common.sourceId, common.timestamp, ordinal, "failed", "error", {
      failure: { class: "provider_error", message: errorText(activity.payload.detail ?? activity.summary), code: null, retryable: null },
    })];
  }
  if (activity.tone === "approval") {
    const payload = activity.payload;
    const prompt = stringValue(payload.prompt) ?? stringValue(payload.detail) ?? activity.summary;
    const requestId = deterministicUuid(`t3-import:v2:request:${thread.sourceKey}:${activity.sourceId}`);
    return [timelineItem(thread, threadId, common.sourceId, common.timestamp, ordinal, status, "approval_request", {
      requestId, requestKind: "command_execution", prompt,
    })];
  }
  return [timelineItem(thread, threadId, common.sourceId, common.timestamp, ordinal, status, "system_notice", {
    message: `${activity.summary}${Object.keys(activity.payload).length ? `: ${stringify(activity.payload)}` : ""}`,
  })];
}

export function encodeCanonicalHistory(
  thread: CanonicalThread,
  threadId: string,
  attachmentsDir: string,
  completeTurns: CanonicalTurn[] = thread.turns,
): EncodedV2History {
  const events: Array<Record<string, unknown>> = [];
  const messages: Array<{ role: string; text: string }> = [];
  const assets: V2HistoryAsset[] = [];
  const warnings: string[] = [];
  let ordinal = 0;
  let activityCount = 0;

  for (const turn of thread.turns) {
    const assistantMessages = turn.assistant;
    const usage = completeTurns.flatMap((candidate) => candidate.id === turn.id ? candidate.activities.filter((activity) => activity.kind === "context-window.updated") : [])
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.sourceId.localeCompare(right.sourceId)).at(-1);
    const ordered: Array<{ message: CanonicalMessage; terminal?: boolean }> = [{ message: turn.user }, ...assistantMessages.map((message, index) => ({ message, ...(index === assistantMessages.length - 1 ? { terminal: true } : {}) }))];
    const turnEvents: Array<{ at: string; key: string; event: Record<string, unknown> }> = [];
    let lastAssistantId: string | undefined;
    for (const { message, terminal } of ordered) {
      const attachment = message.role === "user" ? attachmentPlan(message, threadId, attachmentsDir, warnings) : { descriptors: [], assets: [], notes: [] };
      assets.push(...attachment.assets);
      const messageText = [message.text, ...attachment.notes].filter(Boolean).join("\n\n");
      const messageId = deterministicUuid(`t3-import:v2:message:${thread.sourceKey}:${message.sourceId}`);
      const itemId = deterministicUuid(`t3-import:v2:turn-item:${thread.sourceKey}:${message.sourceId}`);
      const itemStatus = terminal ? nativeStatus(turn.status) : "completed";
      const messagePayload = {
        createdBy: message.role === "user" ? "user" : "agent", creationSource: "server", id: messageId,
        threadId, runId: null, nodeId: null, role: message.role, text: messageText,
        attachments: attachment.descriptors, streaming: false, createdAt: message.timestamp, updatedAt: message.timestamp,
      };
      const base = itemBase(threadId, itemId, 0, message.timestamp, itemStatus);
      const itemPayload = message.role === "user"
        ? { ...base, createdBy: "user", creationSource: "server", type: "user_message", messageId, inputIntent: "turn_start", text: messageText, attachments: attachment.descriptors }
        : { ...base, type: "assistant_message", messageId, text: messageText, streaming: false };
      const eventId = `message:${message.sourceId}`;
      turnEvents.push({ at: message.timestamp, key: message.sourceId, event: event(thread, threadId, eventId, "message.updated", message.timestamp, messagePayload) });
      turnEvents.push({ at: message.timestamp, key: message.sourceId, event: event(thread, threadId, `item:${message.sourceId}`, "turn-item.updated", message.timestamp, itemPayload) });
      if (message.role === "assistant") lastAssistantId = messageId;
      messages.push({ role: message.role, text: messageText });
    }

    const allActivities = turn.activities.filter((activity) => activity.kind !== "context-window.updated");
    const activityIndices = new Map(allActivities.map((activity, index) => [activity.sourceId, index]));
    for (const activity of allActivities) {
      const id = activityIndices.get(activity.sourceId)!;
      const mapped = activityEvents(thread, threadId, activity, 0);
      for (let index = 0; index < mapped.length; index++) turnEvents.push({ at: activity.timestamp, key: activity.sourceId, event: mapped[index]! });
    }
    for (const plan of turn.plans) {
      const mapped = planEvents(thread, threadId, plan.sourceId, plan.timestamp, 0, "proposed_plan", { markdown: plan.markdown });
      mapped.forEach((value) => turnEvents.push({ at: plan.timestamp, key: plan.sourceId, event: value }));
    }
    if (usage) {
      const summary = usageSnapshot(usage, thread.source);
      if (summary) turnEvents.push({ at: usage.timestamp, key: usage.sourceId, event: timelineItem(thread, threadId, usage.sourceId, usage.timestamp, 0, "completed", "system_notice", { message: summary }) });
    }

    const hasFailure = turn.status === "failed" && allActivities.some((activity) => activity.kind.includes("error") || activity.tone === "error");
    if (turn.status === "failed" && !hasFailure) {
      const at = turn.completedAt ?? turn.assistant.at(-1)?.timestamp ?? turn.user.timestamp;
      turnEvents.push({ at, key: "terminal-failure", event: timelineItem(thread, threadId, `${turn.id}:terminal-failure`, at, 0, "failed", "error", {
        failure: { class: "provider_error", message: errorText(turn.terminalError ?? turn.terminalReason), code: null, retryable: null },
      }) });
    } else if (turn.status === "interrupted") {
      const at = turn.completedAt ?? turn.assistant.at(-1)?.timestamp ?? turn.user.timestamp;
      turnEvents.push({ at, key: "terminal-interruption", event: timelineItem(thread, threadId, `${turn.id}:terminal-interruption`, at, 0, "interrupted", "run_interrupt_result", {
        message: turn.terminalReason ?? "The source turn was interrupted.",
      }) });
    }
    turnEvents.sort((left, right) => left.at.localeCompare(right.at) || left.key.localeCompare(right.key));
    for (const entry of turnEvents) {
      const item = entry.event.type === "turn-item.updated" ? entry.event.payload as Record<string, unknown> : undefined;
      if (item) item.ordinal = ++ordinal;
      events.push(entry.event);
      if (item && (item.type !== "user_message" && item.type !== "assistant_message")) activityCount += 1;
    }
    if (turn.status === "failed" && lastAssistantId && !hasFailure) {
      const assistant = turnEvents.find((entry) => (entry.event.payload as Record<string, unknown> | undefined)?.messageId === lastAssistantId);
      if (assistant) (assistant.event.payload as Record<string, unknown>).status = "failed";
    }
  }
  return { events, messages, assets, warnings, activities: activityCount };
}
