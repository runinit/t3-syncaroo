import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as NodeSqlite from "node:sqlite";
import { ensureFixtureLink } from "./safe-link.mjs";
import { deterministicUuid } from "../../../src/core/util.ts";

const [homeArg] = process.argv.slice(2);
const home = resolve(homeArg ?? "");
const t3Root = process.env.T3_V2_T3_SOURCE_DIR;
const dependencyRoot = process.env.T3_V2_T3_DEPENDENCY_ROOT ?? t3Root;
const workspaceRoot = process.env.T3_V2_UPGRADE_WORKSPACE ?? "/tmp/t3-upgrade-fixture";
const threadId = process.env.T3_V2_UPGRADE_THREAD_ID ?? "11111111-1111-4111-8111-111111111111";
const imageSourceId = "legacy-image-06";
const imageBytes = process.env.T3_V2_UPGRADE_IMAGE_BYTES_BASE64
  ? Buffer.from(process.env.T3_V2_UPGRADE_IMAGE_BYTES_BASE64, "base64") : undefined;
const imageAttachmentId = imageBytes ? `${threadId}-${deterministicUuid(`t3-import:attachment:${threadId}:${imageSourceId}`)}` : undefined;
const attachments = imageBytes ? [{ type: "image", id: imageAttachmentId, name: "proof.png", mimeType: "image/png", sizeBytes: imageBytes.length }] : [];
const providerInstance = process.env.T3_V2_UPGRADE_PROVIDER_INSTANCE ?? "codex";
if (!homeArg || !t3Root || !dependencyRoot) throw new Error("usage: T3_V2_T3_SOURCE_DIR=<pinned-t3-source> [T3_V2_T3_DEPENDENCY_ROOT=<installed-pinned-dependencies>] node legacy-upgrade-fixture.mjs <synthetic-home>");
await ensureFixtureLink(join(dependencyRoot, "packages/contracts/node_modules/effect"), join(t3Root, "node_modules/effect"));
await ensureFixtureLink(join(dependencyRoot, "packages/contracts"), join(t3Root, "node_modules/@t3tools/contracts"));
await ensureFixtureLink(join(dependencyRoot, "packages/shared"), join(t3Root, "node_modules/@t3tools/shared"));
await ensureFixtureLink(join(dependencyRoot, "packages/provider-core"), join(t3Root, "node_modules/@t3tools/provider-core"));
await ensureFixtureLink(join(dependencyRoot, "packages/contracts/node_modules/effect"), join(t3Root, "packages/contracts/node_modules/effect"));
await ensureFixtureLink(join(dependencyRoot, "packages/contracts/node_modules/effect"), join(t3Root, "packages/shared/node_modules/effect"));
const t3ToolAliases = join(t3Root, "node_modules/@t3tools");
await mkdir(t3ToolAliases, { recursive: true });
const source = (path) => import(pathToFileURL(join(t3Root, path)).href);
const [Effect, Layer, SqlClient, SqliteClient, Migrations, EventStore, ProjectionStore,
  EventSink, LegacyImporter, ProjectionMaintenance] = await Promise.all([
  import(pathToFileURL(join(dependencyRoot, "packages/contracts/node_modules/effect/dist/Effect.js")).href),
  import(pathToFileURL(join(dependencyRoot, "packages/contracts/node_modules/effect/dist/Layer.js")).href),
  import(pathToFileURL(join(dependencyRoot, "packages/contracts/node_modules/effect/dist/sql/SqlClient.js")).href),
  source("packages/shared/src/nodeSqliteClient.ts"),
  source("apps/server/src/persistence/Migrations.ts"),
  source("apps/server/src/orchestration-v2/EventStore.ts"),
  source("apps/server/src/orchestration-v2/ProjectionStore.ts"),
  source("apps/server/src/orchestration-v2/EventSink.ts"),
  source("apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts"),
  source("apps/server/src/orchestration-v2/ProjectionMaintenance.ts"),
]);

const run = (effect, layer) => Effect.runPromise(Effect.provide(effect, layer));
const sourcePath = join(home, "state.sqlite");
const dbPath = join(home, "statev2.sqlite");
await mkdir(home, { recursive: true });
if (imageBytes) {
  await mkdir(join(home, "attachments"), { recursive: true });
  await writeFile(join(home, "attachments", `${imageAttachmentId}.png`), imageBytes);
}
await writeFile(join(home, ".synthetic-t3-home"), "Disposable legacy-to-v2 upgrade fixture.\n");
const seedLegacy = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Migrations.runMigrations({ toMigrationInclusive: 52 });
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project-06', 'Fixture project', ${workspaceRoot}, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
    VALUES (${threadId}, 'project-06', 'Pre-upgrade imported thread', ${JSON.stringify({ instanceId: providerInstance, model: providerInstance === "claudeAgent" ? "claude-test" : "gpt-5.4" })}, 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.000Z')`;
  yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at)
    VALUES ('legacy-message-06-user', ${threadId}, 'user', 'Question', ${JSON.stringify(attachments)}, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
    VALUES ('legacy-message-06-assistant', ${threadId}, 'assistant', 'Answer', 0, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z')`;
  yield* sql`INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      actor_kind, payload_json, metadata_json
    ) VALUES ('legacy-event-06', 'thread', ${threadId}, 1, 'thread.updated',
      '2026-01-01T00:00:02.000Z', 'server', '{}', '{}')`;
}).pipe(Effect.provide(SqliteClient.layer({ filename: sourcePath })));
await run(seedLegacy, Layer.empty);

// This is the same SQLite backup primitive and adjacent `state.sqlite` source
// path used by initializeV2Database; the real pinned migration and importer
// paths below perform the conversion and lazy transcript hydration.
const sourceDb = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
try { await NodeSqlite.backup(sourceDb, dbPath); }
finally { sourceDb.close(); }
await run(Migrations.runMigrations(), SqliteClient.layer({ filename: dbPath }));

const sqlLayer = SqliteClient.layer({ filename: dbPath });
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer);
const storesWithSql = Layer.provideMerge(stores, sqlLayer);
const sink = Layer.provideMerge(EventSink.layer, storesWithSql);
const importerLayer = Layer.provideMerge(LegacyImporter.layer, Layer.mergeAll(storesWithSql, sink));
await run(Effect.gen(function* () {
  const importer = yield* LegacyImporter.LegacyV1ThreadImporter;
  yield* importer.reconcileShells;
  yield* importer.ensureTranscript(threadId);
}), importerLayer);

const maintenanceLayer = Layer.provideMerge(ProjectionMaintenance.layer, storesWithSql);
const compacted = await run(Effect.gen(function* () {
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  const result = yield* maintenance.compactEventStore;
  const verified = yield* maintenance.verify;
  return { result, verified };
}), maintenanceLayer);
if (!compacted.verified.valid) throw new Error("Pinned T3 verification failed after legacy transcript hydration and compaction.");

// Add one retained-v1 tail row to the synthetic converted DB. This models a
// copied database that keeps legacy application events beyond its v2 cursor.
const dbModule = await import("node:sqlite");
const database = new dbModule.DatabaseSync(dbPath);
try {
  const latest = database.prepare("SELECT * FROM orchestration_events WHERE application_event_version = 2 ORDER BY sequence DESC LIMIT 1").get();
  if (!latest) throw new Error("Legacy import did not create a v2 event stream.");
  const globalMaximum = Number(database.prepare("SELECT COALESCE(MAX(sequence), 0) value FROM orchestration_events").get().value);
  database.prepare(`INSERT INTO orchestration_events (
    sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
    command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json,
    application_event_version
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
    globalMaximum + 100, "synthetic-retained-v1-tail", latest.aggregate_kind, latest.stream_id,
    Number(latest.stream_version) + 1, latest.event_type, latest.occurred_at, latest.command_id,
    latest.causation_event_id, latest.correlation_id, latest.actor_kind, latest.payload_json,
    latest.metadata_json,
  );
} finally {
  database.close();
}

console.log(JSON.stringify({ result: "PASS", sourcePath, dbPath, threadId: threadId, providerInstance, ...(imageBytes ? { imageAttachmentId, imageSourceId } : {}), compacted: compacted.result }));
