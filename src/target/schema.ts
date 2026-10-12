import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import type { TargetPaths } from "../core/types.js";
import { compatibilityError, safetyError } from "../core/errors.js";
import { isObject, stringValue } from "../core/util.js";

export const SUPPORTED_MIGRATIONS = [40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53] as const;

/** Read the current target version, including when recovering an absent ledger. */
export function targetMigration(db: Database.Database): number {
  const row = db.prepare("SELECT COALESCE(MAX(migration_id), 0) migration FROM effect_sql_migrations").get() as { migration: number };
  if (!SUPPORTED_MIGRATIONS.some((migration) => migration === row.migration)) {
    throw compatibilityError(`Unsupported T3 schema migration ${row.migration}; supported migrations are 40–53.`);
  }
  return row.migration;
}

const REQUIRED_COLUMNS: Record<string, string[]> = {
  orchestration_events: ["sequence", "event_id", "aggregate_kind", "stream_id", "stream_version", "event_type", "occurred_at", "actor_kind", "payload_json", "metadata_json"],
  projection_projects: ["project_id", "workspace_root", "deleted_at"],
  projection_state: ["projector", "last_applied_sequence"],
  provider_session_runtime: ["thread_id", "provider_name", "provider_instance_id", "adapter_key", "runtime_mode", "status", "last_seen_at", "resume_cursor_json", "runtime_payload_json"],
};

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function originResponds(origin: string): Promise<boolean> {
  try {
    const response = await fetch(origin, { signal: AbortSignal.timeout(700) });
    return response.status > 0;
  } catch {
    return false;
  }
}

export interface RuntimeState {
  exists: boolean;
  live: boolean;
  pid?: number;
  origin?: string;
  stale: boolean;
}

export async function inspectRuntime(paths: TargetPaths): Promise<RuntimeState> {
  if (!existsSync(paths.runtimeStatePath)) return { exists: false, live: false, stale: false };
  try {
    const value = JSON.parse(readFileSync(paths.runtimeStatePath, "utf8")) as unknown;
    if (!isObject(value)) return { exists: true, live: false, stale: true };
    const pid = typeof value.pid === "number" ? value.pid : undefined;
    const origin = stringValue(value.origin);
    const live = (pid !== undefined && pidAlive(pid)) || (origin !== undefined && await originResponds(origin));
    return { exists: true, live, ...(pid !== undefined ? { pid } : {}), ...(origin ? { origin } : {}), stale: !live };
  } catch {
    return { exists: true, live: false, stale: true };
  }
}

export async function assertT3Closed(paths: TargetPaths): Promise<RuntimeState> {
  const runtime = await inspectRuntime(paths);
  if (runtime.live) throw safetyError(`T3 is running${runtime.pid ? ` (PID ${runtime.pid})` : ""}. Close T3 before importing.`);
  return runtime;
}

export interface SchemaInfo {
  profile: "legacy" | "nightly-v2";
  migration: number;
  integrity: string;
  eventCount: number;
  maxSequence: number;
}

export function assertV2Runtime(nodeVersion = process.versions.node): void {
  const version = nodeVersion.match(/^v?(\d+)\.(\d+)\.(\d+)/u);
  const major = Number(version?.[1]);
  const minor = Number(version?.[2]);
  const supported = major > 24 || (major === 24) || (major === 23 && minor >= 11) || (major === 22 && minor >= 16);
  if (!supported) {
    throw compatibilityError(`The pinned T3 v2 SQLite client requires Node.js 22.16+, 23.11+, or 24+ (detected ${nodeVersion}).`);
  }
}

const V2_REQUIRED_COLUMNS: Record<string, string[]> = {
  effect_sql_migrations: ["migration_id", "name", "created_at"],
  orchestration_events: ["sequence", "event_id", "aggregate_kind", "stream_id", "stream_version", "event_type", "occurred_at", "command_id", "causation_event_id", "correlation_id", "actor_kind", "payload_json", "metadata_json", "application_event_version"],
  orchestration_v2_projection_metadata: ["projection_name", "schema_version", "last_sequence", "updated_at"],
  projection_projects: ["project_id", "workspace_root", "deleted_at"],
  orchestration_v2_projection_threads: ["thread_id", "project_id", "title", "default_provider", "runtime_mode", "interaction_mode", "active_provider_thread_id", "created_at", "updated_at", "archived_at", "deleted_at", "payload_json", "provider_instance_id"],
  orchestration_v2_projection_messages: ["message_id", "thread_id", "run_id", "node_id", "role", "streaming", "created_at", "updated_at", "payload_json"],
  orchestration_v2_projection_turn_items: ["turn_item_id", "thread_id", "run_id", "node_id", "provider_thread_id", "provider_turn_id", "parent_item_id", "ordinal", "type", "status", "updated_at", "payload_json"],
  orchestration_v2_turn_item_positions: ["thread_id", "turn_item_id", "ordinal"],
  orchestration_v2_projection_provider_threads: ["provider_thread_id", "thread_id", "owner_node_id", "provider", "provider_session_id", "status", "first_run_ordinal", "last_run_ordinal", "updated_at", "payload_json", "driver", "provider_instance_id"],
  orchestration_v2_projection_provider_sessions: ["provider_session_id", "thread_id", "provider", "status", "model", "updated_at", "payload_json", "driver", "provider_instance_id"],
};

function v2Migration(db: Database.Database): number {
  const row = db.prepare("SELECT COALESCE(MAX(migration_id), 0) migration FROM effect_sql_migrations").get() as { migration: number };
  return row.migration;
}

function validateNightlyV2(db: Database.Database, names: Set<string>): void {
  const requiredNames = Object.keys(V2_REQUIRED_COLUMNS);
  for (const table of requiredNames) {
    if (!names.has(table)) throw compatibilityError(`Not a compatible T3 nightly v2 database: missing table '${table}'.`);
    const available = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((entry) => entry.name));
    for (const column of V2_REQUIRED_COLUMNS[table]!) {
      if (!available.has(column)) throw compatibilityError(`Unsupported T3 nightly v2 schema: ${table}.${column} is missing.`);
    }
  }
  const migrationRows = db.prepare("SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id IN (55, 61)").all() as Array<{ migration_id: number; name: string }>;
  const migrations = new Map(migrationRows.map(({ migration_id, name }) => [migration_id, name]));
  if (migrations.get(55) !== "OrchestrationV2" || migrations.get(61) !== "PullRequestReviewGuides") {
    throw compatibilityError("Unsupported T3 schema profile: expected the pinned migration 55/61 signatures.");
  }
  const metadata = db.prepare("SELECT schema_version, last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name = 'thread-projections'").get() as { schema_version: number; last_sequence: number } | undefined;
  if (!metadata || ![1, 2].includes(metadata.schema_version)) {
    throw compatibilityError("Unsupported T3 nightly v2 schema: missing or unsupported thread-projections metadata.");
  }
  // EventStoreV2.latestSequence() advances only for application-version-2
  // thread events. Retained v1 events and project events do not move this
  // thread-projection cursor.
  const latestV2ThreadSequence = (db.prepare(`
    SELECT COALESCE(MAX(sequence), 0) maxSequence FROM orchestration_events
    WHERE application_event_version = 2 AND aggregate_kind = 'thread'
  `).get() as { maxSequence: number }).maxSequence;
  if (metadata.last_sequence < latestV2ThreadSequence) {
    throw safetyError(`T3 v2 thread projections are behind the event store (projection ${metadata.last_sequence}, v2 thread events ${latestV2ThreadSequence}). Open T3 and let it finish loading before importing.`);
  }
}

export function validateTargetDatabase(db: Database.Database): SchemaInfo {
  const integrity = String(db.pragma("integrity_check", { simple: true }) ?? "unknown");
  if (integrity !== "ok") throw compatibilityError(`T3 database integrity check failed: ${integrity}`);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  const names = new Set(tables.map((entry) => entry.name));
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!names.has(table)) throw compatibilityError(`Not a compatible T3 database: missing table '${table}'.`);
    const available = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((entry) => entry.name));
    for (const column of columns) if (!available.has(column)) throw compatibilityError(`Unsupported T3 schema: ${table}.${column} is missing.`);
  }
  if (!names.has("effect_sql_migrations")) throw compatibilityError("Not a compatible T3 database: missing migrations table.");
  const migration = v2Migration(db);
  if (migration === 61) {
    assertV2Runtime();
    validateNightlyV2(db, names);
    const events = db.prepare("SELECT COUNT(*) count, COALESCE(MAX(sequence), 0) maxSequence FROM orchestration_events").get() as { count: number; maxSequence: number };
    return { profile: "nightly-v2", migration, integrity, eventCount: events.count, maxSequence: events.maxSequence };
  }
  const legacyMigration = targetMigration(db);
  const events = db.prepare("SELECT COUNT(*) count, COALESCE(MAX(sequence), 0) maxSequence FROM orchestration_events").get() as { count: number; maxSequence: number };
  return { profile: "legacy", migration: legacyMigration, integrity, eventCount: events.count, maxSequence: events.maxSequence };
}
