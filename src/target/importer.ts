import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type {
  CanonicalActivity,
  CanonicalMessage,
  CanonicalThread,
  ImportItemResult,
  ImportRunResult,
  ImportSelection,
  TargetPaths,
} from "../core/types.js";
import { canonicalPath, deterministicUuid, sha256, truncate } from "../core/util.js";
import { checkpointForThread } from "../core/checkpoint.js";
import { safetyError, writeError } from "../core/errors.js";
import { resolveProviderSelection, type TargetOverrides } from "./config.js";
import { assertT3Closed, validateTargetDatabase } from "./schema.js";
import { listImports, recordImports, type LedgerRecord } from "./ledger.js";
import { encodeCanonicalHistory, projectedHistoryMatches, type V2HistoryAsset } from "./v2/history.js";

const EVENT_TYPES = [
  "project.created",
  "thread.created",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.activity-appended",
  "thread.meta-updated",
  "thread.deleted",
] as const;

const plannedEventSchema = z.object({
  eventId: z.string().min(1),
  aggregateKind: z.enum(["project", "thread"]),
  streamId: z.string().min(1),
  type: z.enum(EVENT_TYPES),
  occurredAt: z.iso.datetime(),
  actorKind: z.enum(["client", "server", "provider"]),
  payload: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
});

export interface PlannedEvent extends z.infer<typeof plannedEventSchema> {
  key: string;
}

export interface PlannedAsset {
  descriptor: { type: "image"; id: string; name: string; mimeType: string; sizeBytes: number };
  data?: Buffer;
  sourcePath?: string;
  finalPath: string;
}

export interface PlannedThread {
  thread: CanonicalThread;
  threadId: string;
  projectId: string;
  provider: ReturnType<typeof resolveProviderSelection>;
  events: PlannedEvent[];
  assets: PlannedAsset[];
  resumable: boolean;
  warnings: string[];
  alreadyImported: boolean;
  fingerprint: string;
}

export const MAX_SAFE_IMPORT_EVENTS = 900;
export const IMPORTER_VERSION = "0.4.1";
const MAX_LAST_ERROR_LENGTH = 500;

function settledSession(turn: CanonicalThread["turns"][number]): { status: "ready" | "interrupted" | "error"; lastError: string | null } {
  if (turn.status === "completed") return { status: "ready", lastError: null };
  if (turn.status === "failed") return { status: "error", lastError: truncate(turn.terminalError ?? turn.terminalReason ?? "Imported provider turn failed.", MAX_LAST_ERROR_LENGTH) };
  return { status: "interrupted", lastError: null };
}

function activityPriority(activity: CanonicalActivity): number {
  if (activity.tone === "error" || activity.payload.status === "failed") return 100;
  switch (activity.payload.itemType) {
    case "file_change": return 90;
    case "mcp_tool_call":
    case "dynamic_tool_call": return 80;
    case "command_execution": return 70;
    case "web_search": return 60;
    case "image_view": return 50;
    default: return 40;
  }
}

function compactTurnActivities(activities: CanonicalActivity[]): CanonicalActivity[] {
  if (activities.length === 0) return activities;
  const selected = new Set<number>();
  let latestReasoning = -1;
  let latestPlan = -1;
  let representativeTool = -1;
  const latestOtherByKind = new Map<string, number>();

  activities.forEach((activity, index) => {
    if (activity.kind === "context-window.updated") return;
    if (activity.kind === "reasoning.summary") {
      latestReasoning = index;
      return;
    }
    if (activity.kind === "turn.plan.updated") {
      latestPlan = index;
      return;
    }
    if (activity.kind === "tool.completed") {
      if (
        representativeTool < 0 ||
        activityPriority(activity) >= activityPriority(activities[representativeTool]!)
      ) representativeTool = index;
      return;
    }
    if (
      activity.kind === "context-compaction" ||
      activity.tone === "error" ||
      activity.tone === "approval"
    ) {
      selected.add(index);
      return;
    }
    latestOtherByKind.set(activity.kind, index);
  });

  if (latestReasoning >= 0) selected.add(latestReasoning);
  if (latestPlan >= 0) selected.add(latestPlan);
  if (representativeTool >= 0) selected.add(representativeTool);
  for (const index of latestOtherByKind.values()) selected.add(index);
  return activities.filter((_activity, index) => selected.has(index));
}

export function compactThreadForImport(thread: CanonicalThread): CanonicalThread {
  const turns = thread.turns.map((turn) => ({
    ...turn,
    activities: compactTurnActivities(turn.activities),
  }));
  const before = thread.turns.reduce((sum, turn) => sum + turn.activities.length, 0);
  const after = turns.reduce((sum, turn) => sum + turn.activities.length, 0);
  if (after === before) return { ...thread, turns };
  return {
    ...thread,
    turns,
    warnings: [
      ...thread.warnings,
      `Compacted ${before} source activities to ${after} import activities for T3 startup compatibility.`,
    ],
  };
}

export interface ImportOptions extends TargetOverrides {
  dryRun: boolean;
  resume: boolean;
}

export function projectionBacklog(db: Database.Database): { latestSequence: number; projectedSequence: number; backlog: number } {
  const latestSequence = Number((db.prepare("SELECT COALESCE(MAX(sequence), 0) value FROM orchestration_events").get() as { value: number }).value);
  // Newer T3 versions keep a separate attachment-cleanup retry cursor. It only
  // advances at bootstrap, not for live events, and is not a read-model cursor.
  const projected = db.prepare("SELECT MIN(last_applied_sequence) value FROM projection_state WHERE projector <> 'projection.attachment-cleanup'").get() as { value: number | null };
  const projectedSequence = projected.value ?? 0;
  return {
    latestSequence,
    projectedSequence,
    backlog: Math.max(0, latestSequence - projectedSequence),
  };
}

function safeAttachmentSegment(threadId: string): string {
  return threadId.trim().toLowerCase().replace(/[^a-z0-9_-]+/giu, "-").replace(/-+/gu, "-").replace(/^[-_]+|[-_]+$/gu, "").slice(0, 80).replace(/[-_]+$/gu, "");
}

const imageExtension: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

function attachmentName(name: string, extension: string): string {
  const clean = basename(name).replace(/[\u0000-\u001f]/gu, "").slice(0, 240) || "image";
  return extname(clean) ? clean : `${clean}${extension}`;
}

function planMessageAttachments(
  message: CanonicalMessage,
  threadId: string,
  paths: TargetPaths,
  warnings: string[],
): { descriptors: PlannedAsset["descriptor"][]; assets: PlannedAsset[]; text: string } {
  const descriptors: PlannedAsset["descriptor"][] = [];
  const assets: PlannedAsset[] = [];
  const notes: string[] = [];
  for (const attachment of message.attachments.slice(0, 8)) {
    const extension = imageExtension[attachment.mimeType];
    if (!extension || attachment.sizeBytes > 10 * 1024 * 1024 || attachment.remoteUrl) {
      const reason = attachment.remoteUrl ? "remote images are not downloaded" : !extension ? `unsupported MIME type ${attachment.mimeType}` : "image exceeds 10 MB";
      warnings.push(`Skipped ${attachment.name}: ${reason}.`);
      notes.push(`[Attachment not imported: ${attachment.remoteUrl ?? attachment.name}]`);
      continue;
    }
    const id = `${safeAttachmentSegment(threadId)}-${deterministicUuid(`t3-import:attachment:${threadId}:${attachment.sourceId}`)}`;
    const descriptor = { type: "image" as const, id, name: attachmentName(attachment.name, extension), mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes };
    descriptors.push(descriptor);
    assets.push({ descriptor, ...(attachment.data ? { data: attachment.data } : {}), ...(attachment.path ? { sourcePath: attachment.path } : {}), finalPath: join(paths.attachmentsDir, `${id}${extension}`) });
  }
  if (message.attachments.length > 8) warnings.push(`Message ${message.sourceId} has more than eight images; extras were skipped.`);
  return { descriptors, assets, text: [message.text, ...notes].filter(Boolean).join("\n\n") };
}

export function event(
  seed: string,
  key: string,
  aggregateKind: "project" | "thread",
  streamId: string,
  type: PlannedEvent["type"],
  occurredAt: string,
  actorKind: PlannedEvent["actorKind"],
  payload: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): PlannedEvent {
  const value = { key, eventId: deterministicUuid(`t3-import:event:${seed}:${key}`), aggregateKind, streamId, type, occurredAt, actorKind, payload, metadata };
  plannedEventSchema.parse(value);
  return value;
}

export function modelSelection(provider: PlannedThread["provider"]): Record<string, unknown> {
  return { instanceId: provider.instanceId, model: provider.model, options: provider.options };
}

export function planThread(
  thread: CanonicalThread,
  threadId: string,
  projectId: string,
  paths: TargetPaths,
  provider: PlannedThread["provider"],
  seed: string,
  projectEvent: PlannedEvent | undefined,
  resumable: boolean,
  fingerprint: string,
  turnOffset = 0,
  includeThreadCreated = true,
  threadCreatedMetadata: Record<string, unknown> = {},
): PlannedThread {
  const events: PlannedEvent[] = projectEvent ? [projectEvent] : [];
  const assets: PlannedAsset[] = [];
  const warnings = [...thread.warnings, ...(provider.warning ? [provider.warning] : [])];
  if (thread.turns.some((turn) => turn.status === "inProgress")) warnings.push("Included an active provider snapshot as an interrupted historical turn; it will not be treated as pending in T3.");
  const selection = modelSelection(provider);
  const latestAt = thread.updatedAt;
  if (includeThreadCreated) events.push(event(seed, "thread.created", "thread", threadId, "thread.created", thread.createdAt, "server", {
    threadId, projectId, title: thread.title, modelSelection: selection, runtimeMode: "full-access", interactionMode: "default", branch: thread.gitBranch ?? null, worktreePath: null, createdAt: thread.createdAt, updatedAt: thread.createdAt,
  }, threadCreatedMetadata));
  if (includeThreadCreated && !thread.currentBranch) {
    const activityId = deterministicUuid(`t3-import:activity:${seed}:historical-branch`);
    events.push(event(seed, "historical-branch", "thread", threadId, "thread.activity-appended", thread.createdAt, "provider", {
      threadId,
      activity: { id: activityId, tone: "info", kind: "import.historical-branch", summary: "Historical Claude branch", payload: { detail: warnings[0] }, turnId: null, createdAt: thread.createdAt },
    }, { adapterKey: provider.adapterKey }));
  }

  thread.turns.forEach((turn, turnIndex) => {
    const turnNumber = turnOffset + turnIndex;
    const attachmentPlan = planMessageAttachments(turn.user, threadId, paths, warnings);
    assets.push(...attachmentPlan.assets);
    const userMessageId = deterministicUuid(`t3-import:message:${seed}:${turn.id}:user:${turn.user.sourceId}`);
    events.push(event(seed, `turn.${turnNumber}.user`, "thread", threadId, "thread.message-sent", turn.user.timestamp, "client", {
      threadId, messageId: userMessageId, role: "user", text: attachmentPlan.text, attachments: attachmentPlan.descriptors, turnId: null, streaming: false, createdAt: turn.user.timestamp, updatedAt: turn.user.timestamp,
    }));
    events.push(event(seed, `turn.${turnNumber}.start`, "thread", threadId, "thread.turn-start-requested", turn.startedAt, "client", {
      threadId, messageId: userMessageId, modelSelection: selection, titleSeed: truncate(turn.user.text, 120), runtimeMode: "full-access", interactionMode: "default", createdAt: turn.startedAt,
    }));
    events.push(event(seed, `turn.${turnNumber}.running`, "thread", threadId, "thread.session-set", turn.startedAt, "provider", {
      threadId,
      session: { threadId, status: "running", providerName: provider.providerName, providerInstanceId: provider.instanceId, runtimeMode: "full-access", activeTurnId: turn.id, lastError: null, updatedAt: turn.startedAt },
    }, { adapterKey: provider.adapterKey, providerTurnId: turn.id }));

    // Bootstrap replays each projector independently. The turn projector sees
    // the session projector's final state, so a non-streaming message can mark
    // a turn completed before its terminal session event is read. Settle first;
    // subsequent messages preserve interrupted/error states and their timestamps.
    const settledAt = turn.completedAt ?? turn.assistant.at(-1)?.timestamp ?? turn.user.timestamp;
    const settled = settledSession(turn);
    events.push(event(seed, `turn.${turnNumber}.settled`, "thread", threadId, "thread.session-set", settledAt, "provider", {
      threadId,
      session: { threadId, status: settled.status, providerName: provider.providerName, providerInstanceId: provider.instanceId, runtimeMode: "full-access", activeTurnId: null, lastError: settled.lastError, updatedAt: settledAt },
    }, { adapterKey: provider.adapterKey, providerTurnId: turn.id }));

    const timeline: Array<{ timestamp: string; sourceId: string; type: "message" | "activity" | "plan"; value: CanonicalMessage | CanonicalActivity | { sourceId: string; markdown: string; timestamp: string } }> = [
      ...turn.assistant.map((value) => ({ timestamp: value.timestamp, sourceId: value.sourceId, type: "message" as const, value })),
      ...turn.activities.map((value) => ({ timestamp: value.timestamp, sourceId: value.sourceId, type: "activity" as const, value })),
      ...turn.plans.map((value) => ({ timestamp: value.timestamp, sourceId: value.sourceId, type: "plan" as const, value })),
    ].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sourceId.localeCompare(b.sourceId));
    timeline.forEach((entry, entryIndex) => {
      if (entry.type === "message") {
        const message = entry.value as CanonicalMessage;
        const messageId = deterministicUuid(`t3-import:message:${seed}:${turn.id}:assistant:${message.sourceId}`);
        events.push(event(seed, `turn.${turnNumber}.entry.${entryIndex}.message`, "thread", threadId, "thread.message-sent", message.timestamp, "provider", {
          threadId, messageId, role: "assistant", text: message.text, turnId: turn.id, streaming: false, createdAt: message.timestamp, updatedAt: message.timestamp,
        }, { adapterKey: provider.adapterKey, providerTurnId: turn.id }));
      } else if (entry.type === "activity") {
        const activity = entry.value as CanonicalActivity;
        const activityId = deterministicUuid(`t3-import:activity:${seed}:${turn.id}:${activity.sourceId}`);
        events.push(event(seed, `turn.${turnNumber}.entry.${entryIndex}.activity`, "thread", threadId, "thread.activity-appended", activity.timestamp, "provider", {
          threadId,
          activity: { id: activityId, tone: activity.tone, kind: activity.kind, summary: activity.summary || "Activity", payload: activity.payload, turnId: turn.id, sequence: entryIndex, createdAt: activity.timestamp },
        }, { adapterKey: provider.adapterKey, providerTurnId: turn.id, providerItemId: activity.sourceId }));
      } else {
        const plan = entry.value as { sourceId: string; markdown: string; timestamp: string };
        const planId = deterministicUuid(`t3-import:plan:${seed}:${turn.id}:${plan.sourceId}`);
        events.push(event(seed, `turn.${turnNumber}.entry.${entryIndex}.plan`, "thread", threadId, "thread.proposed-plan-upserted", plan.timestamp, "provider", {
          threadId,
          proposedPlan: { id: planId, turnId: turn.id, planMarkdown: plan.markdown, implementedAt: null, implementationThreadId: null, createdAt: plan.timestamp, updatedAt: plan.timestamp },
        }, { adapterKey: provider.adapterKey, providerTurnId: turn.id, providerItemId: plan.sourceId }));
      }
    });

  });
  return { thread, threadId, projectId, provider, events, assets, resumable, warnings, alreadyImported: false, fingerprint };
}

function existingProjectId(db: Database.Database, workspace: string): string | undefined {
  const normalized = canonicalPath(workspace);
  const rows = db.prepare("SELECT project_id projectId, workspace_root workspaceRoot FROM projection_projects WHERE deleted_at IS NULL").all() as Array<{ projectId: string; workspaceRoot: string }>;
  const projected = rows.find((row) => canonicalPath(row.workspaceRoot) === normalized)?.projectId;
  if (projected) return projected;
  const pending = db.prepare("SELECT stream_id streamId, payload_json payload FROM orchestration_events WHERE event_type = 'project.created'").all() as Array<{ streamId: string; payload: string }>;
  return pending.find((row) => {
    try { const value = JSON.parse(row.payload) as { workspaceRoot?: string }; return value.workspaceRoot ? canonicalPath(value.workspaceRoot) === normalized : false; } catch { return false; }
  })?.streamId;
}

function assertNoTombstonedProject(db: Database.Database, workspace: string): void {
  const normalized = canonicalPath(workspace);
  const rows = db.prepare("SELECT project_id projectId, workspace_root workspaceRoot FROM projection_projects WHERE deleted_at IS NOT NULL").all() as Array<{ projectId: string; workspaceRoot: string }>;
  const deleted = rows.find((row) => canonicalPath(row.workspaceRoot) === normalized);
  if (deleted) throw safetyError(`T3 has a deleted project for ${workspace} (${deleted.projectId}). Restore or rename that project before importing.`);
}

function isImported(db: Database.Database, sourceKey: string, thread: CanonicalThread, threadId: string): boolean {
  const marker = deterministicUuid(`t3-import:event:${sourceKey}:thread.created`);
  const found = db.prepare("SELECT 1 found FROM orchestration_events WHERE event_id = ? OR (stream_id = ? AND event_type = 'thread.created') LIMIT 1").get(marker, threadId);
  if (found) return true;
  if (thread.source === "codex") {
    const legacy = deterministicUuid(`t3-import:event:${thread.sourceSessionId}:thread.created`);
    return Boolean(db.prepare("SELECT 1 found FROM orchestration_events WHERE event_id = ? OR (stream_id = ? AND event_type = 'thread.created') LIMIT 1").get(legacy, thread.sourceSessionId));
  }
  return false;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function acquireLock(paths: TargetPaths): () => void {
  const lockPath = join(paths.stateDir, ".t3-import.lock");
  if (existsSync(lockPath)) {
    try {
      const value = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
      if (typeof value.pid === "number" && pidAlive(value.pid)) throw safetyError(`Another t3-import process is running (PID ${value.pid}).`);
      unlinkSync(lockPath);
    } catch (error) {
      if (error instanceof Error && error.name === "ImporterError") throw error;
      try { unlinkSync(lockPath); } catch { throw safetyError(`Cannot acquire importer lock: ${lockPath}`); }
    }
  }
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx");
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    closeSync(descriptor);
  } catch (error) { throw safetyError(`Cannot acquire importer lock: ${error instanceof Error ? error.message : String(error)}`); }
  return () => { try { unlinkSync(lockPath); } catch { /* best effort */ } };
}

export function createBackup(db: Database.Database, paths: TargetPaths): string {
  const directory = join(paths.stateDir, "t3-import-backups");
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const destination = join(directory, `state-before-import-${stamp}.sqlite`);
  db.prepare("VACUUM INTO ?").run(destination);
  const backup = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    const integrity = String(backup.pragma("integrity_check", { simple: true }));
    if (integrity !== "ok") throw writeError(`Backup integrity check failed: ${destination}`);
  } finally { backup.close(); }
  return destination;
}

export function materializeAssets(plans: Array<{ assets: PlannedAsset[] | V2HistoryAsset[] }>, paths: TargetPaths, runId: string): { created: string[]; cleanup(): void } {
  const staging = join(paths.attachmentsDir, `.t3-import-staging-${runId}`);
  mkdirSync(staging, { recursive: true });
  const created: string[] = [];
  try {
    for (const asset of plans.flatMap((plan) => plan.assets)) {
      const sourceBytes = asset.data ?? (asset.sourcePath && existsSync(asset.sourcePath) ? readFileSync(asset.sourcePath) : undefined);
      if (!sourceBytes) throw writeError(`Attachment ${asset.descriptor.name} has no readable local data.`);
      if (sourceBytes.byteLength !== asset.descriptor.sizeBytes) throw writeError(`Attachment ${asset.descriptor.name} changed size before it could be staged.`);
      if (existsSync(asset.finalPath)) {
        if (!readFileSync(asset.finalPath).equals(sourceBytes)) throw safetyError(`The existing T3 image for ${asset.descriptor.name} does not match the source session. Preserve it and resolve the attachment conflict before retrying.`);
        continue;
      }
      const temporary = join(staging, basename(asset.finalPath));
      if (asset.data) writeFileSync(temporary, asset.data);
      else if (asset.sourcePath) copyFileSync(asset.sourcePath, temporary);
      else throw writeError(`Attachment ${asset.descriptor.name} has no readable local data.`);
      if (!readFileSync(temporary).equals(sourceBytes)) throw writeError(`Attachment ${asset.descriptor.name} changed while it was being staged.`);
      renameSync(temporary, asset.finalPath);
      created.push(asset.finalPath);
    }
    return { created, cleanup: () => rmSync(staging, { recursive: true, force: true }) };
  } catch (error) {
    for (const path of created) rmSync(path, { force: true });
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function aggregateStatus(results: ImportItemResult[], dryRun: boolean): ImportRunResult["status"] {
  if (dryRun) return "dry-run";
  const statuses = new Set(results.map((result) => result.status));
  if (statuses.has("conflict")) return "mixed";
  if (statuses.size > 1) return "mixed";
  return statuses.has("already-imported") ? "already-imported" : "imported";
}

export interface V2ThreadReply {
  threadId: string;
  exists: boolean;
  thread?: { id?: string; projectId?: string; historyOrigin?: string; providerInstanceId?: string; activeProviderThreadId?: string } | null;
  events?: Array<{ id: string; sequence: number }>;
  records?: {
    thread?: { id?: string; projectId?: string; historyOrigin?: string; providerInstanceId?: string; activeProviderThreadId?: string };
    messages?: Array<{ id: string; threadId?: string; role: string; text: string; attachments?: Array<Record<string, unknown>>; createdAt?: string }>;
    turnItems?: Array<Record<string, unknown>>;
    plans?: Array<Record<string, unknown>>;
    providerTurns?: Array<Record<string, unknown>>;
    providerThreads?: Array<{ id: string; appThreadId?: string; driver?: string; providerInstanceId?: string; nativeThreadRef?: { driver?: string; nativeId?: string; strength?: string } | null; nativeConversationHeadRef?: { driver?: string; nativeId?: string; strength?: string } | null }>;
  };
  snapshot?: { projection?: { thread?: Record<string, unknown> } };
}

export interface V2NativeReply {
  ok: boolean;
  error?: string;
  integrity?: string;
  migrations?: Array<{ migrationId: number; name: string }>;
  profile?: { isV2Schema?: boolean; requiredTablesPresent?: boolean; schemaRevision?: number };
  projectionMetadata?: { schemaVersion: number; lastSequence: number } | null;
  threads?: V2ThreadReply[];
  projects?: Array<{ id?: string; projectId?: string; workspaceRoot?: string; deletedAt?: string | null; [key: string]: unknown }>;
  outcome?: "written" | "already-present" | "write-failed" | "replaced" | "already-replaced" | "replace-conflict" | "readback-conflict" | "attached" | "already-attached" | "attach-conflict";
  reason?: string;
  replacementThreadId?: string;
  storedSequences?: Array<{ eventId: string; threadId: string; sequence: number }>;
  sequences?: number[];
  firstSequence?: number;
  lastSequence?: number;
  storedSequenceRange?: { first: number; last: number } | null;
  projections?: Array<V2ThreadReply & { snapshot?: V2ThreadReply }>;
  projectCommitted?: boolean;
  projectCompensated?: boolean;
}

export interface V2Plan {
  thread: CanonicalThread;
  threadId: string;
  identitySeed: string;
  projectId: string;
  provider: ReturnType<typeof resolveProviderSelection>;
  events: Array<Record<string, unknown>>;
  assets: V2HistoryAsset[];
  warnings: string[];
  activities: number;
  attachments: number;
  projectEvent?: Record<string, unknown>;
  messages: Array<{ role: string; text: string }>;
  resumable: boolean;
  fingerprint: string;
}

export interface V2PlanOptions {
  threadId?: string;
  identitySeed?: string;
  /** Replacement may preserve or decline an existing binding, but never force one. */
  disableResume?: boolean;
}

function v2HelperPath(): string {
  const candidates = [
    fileURLToPath(new URL("../../vendor/t3-v2-native-helper.mjs", import.meta.url)),
    fileURLToPath(new URL("../../artifacts/v2-native/helper.mjs", import.meta.url)),
  ];
  const helper = candidates.find((path) => existsSync(path));
  if (!helper) throw writeError("The packaged T3 v2 native helper is missing. Reinstall t3-import or rebuild its pinned helper.");
  return helper;
}

export function callV2Native(paths: TargetPaths, request: Record<string, unknown>): Promise<V2NativeReply> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [v2HelperPath()], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => reject(writeError(`Could not start the T3 v2 native helper: ${error.message}`, error)));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(writeError(`The T3 v2 native helper failed${stderr.trim() ? `: ${stderr.trim()}` : ` (exit ${code})`}.`));
        return;
      }
      let response: V2NativeReply;
      try { response = JSON.parse(stdout.trim()) as V2NativeReply; }
      catch (error) {
        reject(writeError(`The T3 v2 native helper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, error));
        return;
      }
      if (response.ok !== true) {
        if (request.op === "replace" || (request.op === "attach-upgraded-binding" && response.outcome === "attach-conflict")) {
          resolve(response);
          return;
        }
        const recovery = response.projectCommitted && !response.projectCompensated
          ? " A project was created but could not be removed; restore the verified backup before retrying."
          : "";
        reject(writeError(`${response.error ?? "The native helper rejected the request."}${recovery}`));
        return;
      }
      resolve(response);
    });
    child.stdin.end(JSON.stringify({ ...request, dbPath: paths.dbPath }));
  });
}

export function planV2Thread(selection: ImportSelection, thread: CanonicalThread, paths: TargetPaths, projectId: string, createProject: boolean, providerInstance?: string, options: V2PlanOptions = {}): V2Plan {
  if (!thread.currentBranch && thread.source === "codex") throw safetyError(`Codex session ${thread.sourceSessionId} has a non-current branch; branch history is not supported by this T3 v2 import slice.`);
  if (!thread.turns.length || thread.turns.some((turn) => turn.status === "inProgress")) {
    throw safetyError(`${thread.source} session ${thread.sourceSessionId} is not settled. Select a completed, interrupted, or failed conversation.`);
  }
  const compacted = compactThreadForImport(thread);
  const identitySeed = options.identitySeed ?? thread.sourceKey;
  const threadId = options.threadId ?? (thread.source === "codex" && /^[0-9a-f-]{36}$/iu.test(thread.sourceSessionId)
    ? thread.sourceSessionId
    : deterministicUuid(`t3-import:thread:${thread.sourceKey}`));
  const provider = resolveProviderSelection(paths, thread.source, thread.model, thread.effort, providerInstance);
  const providerThreadId = deterministicUuid(`t3-import:v2:provider-thread:${identitySeed}`);
  const createdAt = thread.createdAt;
  const updatedAt = thread.updatedAt;
  const title = thread.title.trim() || "Untitled thread";
  const appThread = {
    createdBy: "system", creationSource: "server", id: threadId, projectId, title,
    providerInstanceId: provider.instanceId, modelSelection: modelSelection(provider),
    runtimeMode: "full-access", interactionMode: "default", branch: thread.gitBranch ?? null, worktreePath: null,
    linkedPullRequest: null, branchPullRequest: null, activeProviderThreadId: providerThreadId,
    historyOrigin: "v1_import", lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null, createdAt, updatedAt, archivedAt: null, settledOverride: "settled",
    settledAt: updatedAt, unsettledAt: null, snoozedUntil: null, snoozedAt: null, pinnedAt: null,
    pinOrderKey: null, activeOrderKey: null, lastVisitedAt: null, deletedAt: null,
  };
  const cursor = thread.resumeCursor ?? {};
  const nativeId = thread.source === "claude" ? thread.sourceSessionId : String(cursor.threadId ?? thread.sourceSessionId);
  const nativeHead = thread.source === "claude" && typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;
  const nativeDriver = provider.providerName;
  const canResume = thread.source === "codex" ? Boolean(cursor.threadId) : Boolean(nativeHead);
  const resumable = !options.disableResume && optionsResume(selection, thread, canResume);
  const nativeProviderThread = {
    id: providerThreadId, driver: nativeDriver, providerInstanceId: provider.instanceId, providerSessionId: null,
    appThreadId: threadId, ownerNodeId: null,
    nativeThreadRef: resumable ? { driver: nativeDriver, nativeId, strength: "strong" } : null,
    nativeConversationHeadRef: resumable && nativeHead ? { driver: nativeDriver, nativeId: nativeHead, strength: "strong" } : null,
    status: "idle", firstRunOrdinal: null, lastRunOrdinal: null,
    handoffIds: [], forkedFrom: null, pendingBackgroundTasks: [], createdAt, updatedAt,
  };
  const historyThread = identitySeed === thread.sourceKey ? compacted : { ...compacted, sourceKey: identitySeed };
  const history = encodeCanonicalHistory(historyThread, threadId, paths.attachmentsDir, thread.turns);
  const events: Array<Record<string, unknown>> = [{
    id: deterministicUuid(`t3-import:v2:event:${identitySeed}:thread-created`), type: "thread.created",
    threadId, providerInstanceId: provider.instanceId, occurredAt: createdAt, payload: appThread,
  }, ...history.events, {
    id: deterministicUuid(`t3-import:v2:event:${identitySeed}:provider-thread`), type: "provider-thread.updated",
    threadId, driver: nativeDriver, providerInstanceId: provider.instanceId, occurredAt: updatedAt,
    payload: nativeProviderThread,
  }];
  const projectEvent = createProject ? {
    commandId: deterministicUuid(`t3-import:v2:project-command:${canonicalPath(thread.workspace)}`),
    commandType: "project.create", acceptedAt: createdAt,
    event: {
      eventId: deterministicUuid(`t3-import:v2:project-event:${canonicalPath(thread.workspace)}`),
      aggregateKind: "project", aggregateId: projectId, occurredAt: createdAt,
      commandId: deterministicUuid(`t3-import:v2:project-command:${canonicalPath(thread.workspace)}`),
      causationEventId: null, correlationId: null, metadata: {}, type: "project.created",
      payload: { projectId, title: basename(thread.workspace), workspaceRoot: thread.workspace,
        defaultModelSelection: modelSelection(provider), scripts: [], createdAt, updatedAt },
    },
  } : undefined;
  return {
    thread, threadId, identitySeed, projectId, provider, events,
    ...(projectEvent ? { projectEvent } : {}), messages: history.messages, assets: history.assets,
    warnings: [...compacted.warnings.slice(thread.warnings.length), ...history.warnings],
    activities: history.activities, attachments: history.assets.length,
    resumable, fingerprint: selection.conversation.fingerprint,
  };
}

function optionsResume(selection: ImportSelection, thread: CanonicalThread, canResume: boolean): boolean {
  return canResume && selection.resume && (thread.source === "claude" || thread.currentBranch);
}

function v2HistoryMatches(value: V2ThreadReply | undefined, plan: V2Plan): boolean {
  const nativeThread = value?.records?.thread ?? value?.thread;
  const messages = value?.records?.messages ?? [];
  const sessions = value?.records?.providerThreads ?? [];
  return value?.exists === true
    && nativeThread?.id === plan.threadId
    && nativeThread.projectId === plan.projectId
    && nativeThread.historyOrigin === "v1_import"
    && nativeThread.providerInstanceId === plan.provider.instanceId
    && messages.length === plan.messages.length
    && messages.every((message, index) => message.role === plan.messages[index]?.role && message.text === plan.messages[index]?.text)
    && v2ProjectedHistoryMatches(value, plan)
    && sessions.some((session) => session.appThreadId === plan.threadId
      && session.driver === plan.provider.providerName
      && session.providerInstanceId === plan.provider.instanceId
      && (plan.resumable
        ? session.nativeThreadRef?.driver === plan.provider.providerName
          && session.nativeThreadRef.strength === "strong"
          && session.nativeThreadRef.nativeId === (plan.thread.source === "claude" ? plan.thread.sourceSessionId : String(plan.thread.resumeCursor?.threadId ?? plan.thread.sourceSessionId))
          && (plan.thread.source !== "claude" || (typeof plan.thread.resumeCursor?.resumeSessionAt === "string"
            ? session.nativeConversationHeadRef?.driver === plan.provider.providerName && session.nativeConversationHeadRef.nativeId === plan.thread.resumeCursor.resumeSessionAt
            : session.nativeConversationHeadRef === null))
        : session.nativeThreadRef === null && session.nativeConversationHeadRef === null));
}

function v2ProjectedHistoryMatches(value: V2ThreadReply | undefined, plan: V2Plan): boolean {
  return projectedHistoryMatches(value?.records, plan.events);
}

function v2EventOwnershipMatches(value: V2ThreadReply | undefined, plan: V2Plan): boolean {
  const actual = value?.events;
  const expected = plan.events.map((event) => String(event.id));
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((event, index) => event.id === expected[index]
      && Number.isSafeInteger(event.sequence)
      && event.sequence > 0
      && (index === 0 || event.sequence > actual[index - 1]!.sequence));
}

function v2LedgerRecord(plan: V2Plan, paths: TargetPaths, firstSequence: number, lastSequence: number, backupPath: string, warnings: string[]): LedgerRecord {
  return {
    targetId: sha256(canonicalPath(paths.dbPath)), source: plan.thread.source,
    sourceSessionId: plan.thread.sourceSessionId, sourceKey: plan.thread.sourceKey,
    sourceFingerprint: plan.fingerprint, projectId: plan.projectId, threadId: plan.threadId,
    importedAt: new Date().toISOString(), importerVersion: IMPORTER_VERSION,
    migration: 61, firstSequence, lastSequence,
    resumable: plan.resumable, backupPath, warnings,
    identitySeed: plan.identitySeed, currentSourceKey: plan.thread.sourceKey,
    ...(plan.thread.leafId ? { sourceLeafId: plan.thread.leafId } : {}),
    ...(plan.resumable && plan.thread.source === "claude" && typeof plan.thread.resumeCursor?.resumeSessionAt === "string" ? { nativeConversationHeadId: plan.thread.resumeCursor.resumeSessionAt } : {}),
    sourceTitle: plan.thread.title, checkpoint: checkpointForThread(plan.thread), isCanonical: true,
  };
}

function verifyOrRecoverV2Assets(plan: V2Plan, paths: TargetPaths, allowMissingRecovery: boolean): void {
  const missing: V2HistoryAsset[] = [];
  for (const asset of plan.assets) {
    const expected = asset.data ?? (asset.sourcePath && existsSync(asset.sourcePath) ? readFileSync(asset.sourcePath) : undefined);
    if (!expected) throw safetyError(`The source bytes for ${asset.descriptor.name} are unavailable, so T3 image history cannot be verified. Restore the source attachment before retrying.`);
    if (!existsSync(asset.finalPath)) {
      missing.push(asset);
      continue;
    }
    const current = readFileSync(asset.finalPath);
    if (!current.equals(expected)) throw safetyError(`The existing T3 image for ${asset.descriptor.name} does not match the source session. Preserve it and resolve the attachment conflict before retrying.`);
  }
  if (missing.length === 0) return;
  if (!allowMissingRecovery) throw safetyError("T3 has imported image references but the attachment bytes are missing and no matching import checkpoint proves their contents. Restore the verified backup or resolve the attachment conflict before retrying.");
  const staged = materializeAssets([{ assets: missing }], paths, randomUUID());
  staged.cleanup();
}

async function importNightlyV2(
  selections: ImportSelection[],
  paths: TargetPaths,
  options: ImportOptions,
): Promise<ImportRunResult> {
  const db = new Database(paths.dbPath, { readonly: true, fileMustExist: true });
  let plans: V2Plan[] = [];
  try {
    const projectIds = new Map<string, string>();
    for (const selection of selections) {
      for (const thread of selection.conversation.threads) {
        const workspaceKey = canonicalPath(thread.workspace);
        assertNoTombstonedProject(db, thread.workspace);
        const knownProject = projectIds.get(workspaceKey);
        const projectedProject = knownProject ?? existingProjectId(db, thread.workspace);
        const projectId = projectedProject ?? deterministicUuid(`t3-import:project:${workspaceKey}`);
        projectIds.set(workspaceKey, projectId);
        plans.push(planV2Thread(selection, thread, paths, projectId, !projectedProject, options.providerInstance));
      }
    }
  } finally {
    db.close();
  }
  const plannedEventCount = plans.reduce((count, plan) => count + plan.events.length, 0);
  if (plannedEventCount > MAX_SAFE_IMPORT_EVENTS) {
    throw safetyError(`The Codex text import would append ${plannedEventCount} events, exceeding the safe one-launch limit of ${MAX_SAFE_IMPORT_EVENTS}. Split the import into smaller batches before retrying.`);
  }

  const inspection = await callV2Native(paths, {
    op: "inspect",
    threadIds: plans.map((plan) => plan.threadId),
    projectIds: [...new Set(plans.map((plan) => plan.projectId))],
  });
  if (inspection.integrity !== "ok" || inspection.profile?.isV2Schema !== true || inspection.profile.requiredTablesPresent !== true) {
    throw safetyError("The pinned native reader could not confirm this as an intact T3 v2 database. No changes were made.");
  }
  const projectsById = new Map((inspection.projects ?? []).map((project) => [project.projectId ?? project.id, project]));
  for (const plan of plans) {
    const nativeProject = projectsById.get(plan.projectId);
    if (nativeProject?.deletedAt) {
      throw safetyError(`T3 project ${plan.projectId} for ${plan.thread.workspace} is deleted. Restore it before importing.`);
    }
    if (nativeProject && canonicalPath(String(nativeProject.workspaceRoot ?? "")) !== canonicalPath(plan.thread.workspace)) {
      throw safetyError(`T3 project ${plan.projectId} does not match the source workspace for ${plan.thread.sourceSessionId}.`);
    }
  }
  const inspectedById = new Map((inspection.threads ?? []).map((thread) => [thread.threadId, thread]));
  const existing = new Set<string>();
  const recoveryWarnings: string[] = [];
  for (const plan of plans) {
    const prior = inspectedById.get(plan.threadId);
    if (prior?.exists) {
      if (!v2HistoryMatches(prior, plan) || !v2EventOwnershipMatches(prior, plan)) {
        throw safetyError(`T3 already has a different task for ${plan.thread.source} session ${plan.thread.sourceSessionId}. Keep the existing task and resolve the history conflict before importing.`);
      }
      existing.add(plan.threadId);
      if (!options.dryRun) {
        const targetId = sha256(canonicalPath(paths.dbPath));
        let ledgerRows;
        try { ledgerRows = listImports(targetId, plan.thread.source); }
        catch (error) {
          throw writeError(`T3 already contains the exact imported history for ${plan.thread.source} session ${plan.thread.sourceSessionId}, but its external ledger could not be checked: ${error instanceof Error ? error.message : String(error)}. No native events were replayed.`, error);
        }
        const mapped = ledgerRows.find((row) => row.sourceKey === plan.thread.sourceKey && row.threadId === plan.threadId);
        if (mapped && mapped.sourceFingerprint !== plan.fingerprint) {
          throw safetyError(`T3 already has this imported task, but its source session has changed since import. Use sync or resolve the history conflict before retrying.`);
        }
        verifyOrRecoverV2Assets(plan, paths, Boolean(mapped));
        if (!mapped) {
          const sequences = prior.events!.map((event) => event.sequence);
          const warning = "Recovered the external import ledger from exact native event ownership; the original backup path was not retained.";
          try {
            recordImports([v2LedgerRecord(plan, paths, Math.min(...sequences), Math.max(...sequences), "", [warning])]);
            recoveryWarnings.push(warning);
          } catch (error) {
            throw writeError(`T3 already contains the exact imported history for ${plan.thread.source} session ${plan.thread.sourceSessionId}, but its external ledger could not be recovered: ${error instanceof Error ? error.message : String(error)}. No native events were replayed.`, error);
          }
        }
      }
    }
  }

  const results: ImportItemResult[] = plans.map((plan) => ({
    source: plan.thread.source,
    sourceId: plan.thread.sourceSessionId,
    sourceKey: plan.thread.sourceKey,
    status: existing.has(plan.threadId) ? "already-imported" : options.dryRun ? "dry-run" : "imported",
    threadId: plan.threadId,
    projectId: plan.projectId,
    title: plan.thread.title,
    turns: plan.thread.turns.length,
    messages: plan.messages.length,
    activities: plan.activities,
    events: plan.events.length,
    attachments: plan.attachments,
    resumable: plan.resumable,
    warnings: [...plan.thread.warnings, ...plan.warnings, ...(plan.provider.warning ? [plan.provider.warning] : []), ...(existing.has(plan.threadId) && recoveryWarnings.length ? ["An external import ledger mapping was recovered for this T3 history."] : [])],
  }));
  const pending = plans.filter((plan) => !existing.has(plan.threadId));
  if (options.dryRun || pending.length === 0) {
    return { schemaVersion: 1, status: aggregateStatus(results, options.dryRun), target: paths.dbPath, migration: 61, backup: null, results, warnings: recoveryWarnings };
  }

  const backupDb = new Database(paths.dbPath, { fileMustExist: true });
  let backup: string;
  try { backup = createBackup(backupDb, paths); }
  finally { backupDb.close(); }

  const warnings: string[] = [];
  for (const plan of pending) {
    const assets = materializeAssets([plan], paths, randomUUID());
    let write: V2NativeReply;
    try {
      write = await callV2Native(paths, { op: "write", ...(plan.projectEvent ? { projectEvent: plan.projectEvent } : {}), events: plan.events });
    } catch (error) {
      assets.cleanup();
      try {
        const afterFailure = await callV2Native(paths, { op: "inspect", threadIds: [plan.threadId], projectIds: [] });
        const failedThread = afterFailure.threads?.find((thread) => thread.threadId === plan.threadId);
        if (failedThread?.exists === false && failedThread.events?.length === 0) {
          for (const path of assets.created) rmSync(path, { force: true });
        }
      } catch {
        // If the helper cannot confirm rollback, retain bytes so a possibly
        // committed native history cannot be left pointing at missing images.
      }
      throw writeError(`${error instanceof Error ? error.message : String(error)} The verified backup is ${backup}.`, error);
    }
    assets.cleanup();
    const result = results.find((item) => item.threadId === plan.threadId)!;
    const sequenceRange = write.storedSequenceRange ?? (write.firstSequence && write.lastSequence ? { first: write.firstSequence, last: write.lastSequence } : undefined);
    const projection = write.projections?.find((thread) => thread.threadId === plan.threadId);
    const readback: V2ThreadReply | undefined = projection ? {
      threadId: projection.threadId,
      exists: true,
      ...(projection.records ? { records: projection.records } : {}),
    } : undefined;
    if (!sequenceRange || !readback || !v2HistoryMatches(readback, plan)) {
      throw writeError(`T3 v2 did not return committed event sequences for ${plan.thread.sourceSessionId}. The verified backup is ${backup}.`);
    }
    result.sequence = { first: sequenceRange.first, last: sequenceRange.last };
    const record = v2LedgerRecord(plan, paths, sequenceRange.first, sequenceRange.last, backup, result.warnings);
    try { recordImports([record]); }
    catch (error) { warnings.push(`Import succeeded, but the external ledger could not be updated: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { schemaVersion: 1, status: aggregateStatus(results, false), target: paths.dbPath, migration: 61, backup, results, warnings };
}

export async function importConversations(
  selections: ImportSelection[],
  paths: TargetPaths,
  options: ImportOptions,
): Promise<ImportRunResult> {
  if (!existsSync(paths.dbPath)) throw safetyError(`T3 database not found: ${paths.dbPath}`);
  await assertT3Closed(paths);
  const releaseLock = options.dryRun ? () => {} : acquireLock(paths);
  const db = new Database(paths.dbPath, { readonly: options.dryRun, fileMustExist: true });
  let backup: string | null = null;
  const runWarnings: string[] = [];
  let dbOpen = true;
  try {
    const schema = validateTargetDatabase(db);
    if (schema.profile === "nightly-v2") {
      db.close();
      dbOpen = false;
      return await importNightlyV2(selections, paths, options);
    }
    const planned: PlannedThread[] = [];
    const projectIds = new Map<string, string>();
    const plannedProjectEvents = new Set<string>();
    for (const selection of selections) {
      for (const sourceThread of selection.conversation.threads) {
        const thread = compactThreadForImport(sourceThread);
        if (thread.turns.length === 0) throw writeError(`Conversation ${thread.sourceSessionId} has no terminal turns to import. Use --include-incomplete to import an active snapshot as interrupted history.`);
        const threadId = thread.source === "codex" && /^[0-9a-f-]{36}$/iu.test(thread.sourceSessionId)
          ? thread.sourceSessionId
          : deterministicUuid(`t3-import:thread:${thread.sourceKey}`);
        const imported = isImported(db, thread.sourceKey, thread, threadId);
        const workspaceKey = canonicalPath(thread.workspace);
        let projectId = projectIds.get(workspaceKey) ?? existingProjectId(db, thread.workspace);
        if (!projectId) projectId = deterministicUuid(`t3-import:project:${workspaceKey}`);
        projectIds.set(workspaceKey, projectId);
        const provider = resolveProviderSelection(paths, thread.source, thread.model, thread.effort, options.providerInstance);
        const seed = thread.sourceKey;
        const projectEvent = !imported && !existingProjectId(db, thread.workspace) && !plannedProjectEvents.has(projectId)
          ? event(`project:${workspaceKey}`, "project.created", "project", projectId, "project.created", thread.createdAt, "client", {
              projectId, title: basename(thread.workspace), workspaceRoot: thread.workspace, defaultModelSelection: modelSelection(provider), scripts: [], createdAt: thread.createdAt, updatedAt: thread.updatedAt,
            })
          : undefined;
        if (projectEvent) plannedProjectEvents.add(projectId);
        const resumable = options.resume && selection.resume && thread.currentBranch && Boolean(thread.resumeCursor);
        const plan = planThread(thread, threadId, projectId, paths, provider, seed, projectEvent, resumable, selection.conversation.fingerprint);
        plan.alreadyImported = imported;
        planned.push(plan);
      }
    }

    const results: ImportItemResult[] = planned.map((plan) => ({
      source: plan.thread.source,
      sourceId: plan.thread.sourceSessionId,
      sourceKey: plan.thread.sourceKey,
      status: plan.alreadyImported ? "already-imported" : options.dryRun ? "dry-run" : "imported",
      threadId: plan.threadId,
      projectId: plan.projectId,
      title: plan.thread.title,
      turns: plan.thread.turns.length,
      messages: plan.thread.turns.reduce((sum, turn) => sum + 1 + turn.assistant.length, 0),
      activities: plan.thread.turns.reduce((sum, turn) => sum + turn.activities.length, 0) + (plan.thread.currentBranch ? 0 : 1),
      events: plan.events.length,
      attachments: plan.assets.length,
      resumable: plan.resumable,
      warnings: plan.warnings,
    }));
    const toWrite = planned.filter((plan) => !plan.alreadyImported);
    if (toWrite.length > 0) {
      const projection = projectionBacklog(db);
      if (projection.backlog > 0) {
        throw safetyError(
          `T3 has ${projection.backlog} unprojected event${projection.backlog === 1 ? "" : "s"} ` +
          `(event sequence ${projection.latestSequence}, projection sequence ${projection.projectedSequence}). ` +
          "Open T3 and let it finish loading before importing more conversations.",
        );
      }
      const plannedEventCount = toWrite.reduce((sum, plan) => sum + plan.events.length, 0);
      if (plannedEventCount > MAX_SAFE_IMPORT_EVENTS) {
        throw safetyError(
          `The compact import would append ${plannedEventCount} events, exceeding the safe one-launch limit of ${MAX_SAFE_IMPORT_EVENTS}. ` +
          "Import fewer conversations at a time or select shorter histories.",
        );
      }
    }
    if (options.dryRun || toWrite.length === 0) {
      return { schemaVersion: 1, status: aggregateStatus(results, options.dryRun), target: paths.dbPath, migration: schema.migration, backup: null, results, warnings: runWarnings };
    }

    backup = createBackup(db, paths);
    mkdirSync(paths.attachmentsDir, { recursive: true });
    const assets = materializeAssets(toWrite, paths, randomUUID());
    const ledger: LedgerRecord[] = [];
    try {
      const nextVersion = db.prepare("SELECT COALESCE(MAX(stream_version), -1) + 1 nextVersion FROM orchestration_events WHERE aggregate_kind = ? AND stream_id = ?");
      const insert = db.prepare(`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)
      `);
      const upsertRuntime = db.prepare(`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key,
          runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json
        ) VALUES (?, ?, ?, ?, 'full-access', 'stopped', ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          provider_name=excluded.provider_name,
          provider_instance_id=excluded.provider_instance_id,
          adapter_key=excluded.adapter_key,
          runtime_mode=excluded.runtime_mode,
          status=excluded.status,
          last_seen_at=excluded.last_seen_at,
          resume_cursor_json=excluded.resume_cursor_json,
          runtime_payload_json=excluded.runtime_payload_json
      `);
      const streamVersions = new Map<string, number>();
      db.transaction(() => {
        for (const plan of toWrite) {
          let firstSequence = Number.MAX_SAFE_INTEGER;
          let lastSequence = 0;
          for (const plannedEvent of plan.events) {
            const streamKey = `${plannedEvent.aggregateKind}:${plannedEvent.streamId}`;
            const version = streamVersions.get(streamKey) ?? (nextVersion.get(plannedEvent.aggregateKind, plannedEvent.streamId) as { nextVersion: number }).nextVersion;
            const result = insert.run(plannedEvent.eventId, plannedEvent.aggregateKind, plannedEvent.streamId, version, plannedEvent.type, plannedEvent.occurredAt, plannedEvent.actorKind, JSON.stringify(plannedEvent.payload), JSON.stringify(plannedEvent.metadata));
            const sequence = Number(result.lastInsertRowid);
            firstSequence = Math.min(firstSequence, sequence);
            lastSequence = Math.max(lastSequence, sequence);
            streamVersions.set(streamKey, version + 1);
          }
          if (plan.resumable && plan.thread.resumeCursor) {
            const cursor = plan.thread.source === "claude" ? { threadId: plan.threadId, ...plan.thread.resumeCursor } : plan.thread.resumeCursor;
            upsertRuntime.run(plan.threadId, plan.provider.providerName, plan.provider.instanceId, plan.provider.adapterKey, plan.thread.updatedAt, JSON.stringify(cursor), JSON.stringify({ cwd: plan.thread.workspace, model: plan.provider.model, activeTurnId: null, lastError: null, modelSelection: modelSelection(plan.provider), lastRuntimeEvent: `t3-import.${plan.thread.source}`, lastRuntimeEventAt: plan.thread.updatedAt }));
          }
          const result = results.find((entry) => entry.threadId === plan.threadId)!;
          result.sequence = { first: firstSequence, last: lastSequence };
          ledger.push({
            targetId: sha256(canonicalPath(paths.dbPath)), source: plan.thread.source,
            sourceSessionId: plan.thread.sourceSessionId, sourceKey: plan.thread.sourceKey,
            sourceFingerprint: plan.fingerprint, projectId: plan.projectId, threadId: plan.threadId,
            importedAt: new Date().toISOString(), importerVersion: IMPORTER_VERSION,
            migration: schema.migration, firstSequence, lastSequence,
            resumable: plan.resumable, backupPath: backup!, warnings: plan.warnings,
            identitySeed: plan.thread.sourceKey, currentSourceKey: plan.thread.sourceKey,
            ...(plan.thread.leafId ? { sourceLeafId: plan.thread.leafId } : {}),
            sourceTitle: plan.thread.title, checkpoint: checkpointForThread(plan.thread),
            isCanonical: true,
          });
        }
      })();
      assets.cleanup();
    } catch (error) {
      for (const path of assets.created) rmSync(path, { force: true });
      assets.cleanup();
      throw error;
    }
    const integrity = String(db.pragma("integrity_check", { simple: true }));
    if (integrity !== "ok") throw writeError(`Post-import integrity check failed: ${integrity}`);
    try { recordImports(ledger); } catch (error) { runWarnings.push(`Import succeeded, but the external ledger could not be updated: ${error instanceof Error ? error.message : String(error)}`); }
    return { schemaVersion: 1, status: aggregateStatus(results, false), target: paths.dbPath, migration: schema.migration, backup, results, warnings: runWarnings };
  } catch (error) {
    if (error instanceof Error && error.name === "ImporterError") throw error;
    throw writeError(`Import failed: ${error instanceof Error ? error.message : String(error)}`, error);
  } finally {
    if (dbOpen) db.close();
    releaseLock();
  }
}
