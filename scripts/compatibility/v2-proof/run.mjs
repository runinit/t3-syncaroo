import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, lstat, readlink, rm, symlink } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../../..");
const t3Root = resolve(projectRoot, "artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e");
const t3 = (path) => pathToFileURL(resolve(t3Root, path)).href;

const ensureLink = async (target, linkPath) => {
  await mkdir(dirname(linkPath), { recursive: true });
  try {
    await lstat(linkPath);
    const current = await readlink(linkPath);
    if (resolve(dirname(linkPath), current) !== target) {
      await rm(linkPath, { recursive: true, force: true });
      await symlink(target, linkPath, "dir");
    }
  } catch {
    await symlink(target, linkPath, "dir");
  }
};
const referenceNodeModules = join(t3Root, "node_modules");
const referenceDeps = resolve(t3Root, "packages/contracts/node_modules");
await ensureLink(resolve(referenceDeps, "effect"), join(referenceNodeModules, "effect"));
await ensureLink(resolve(t3Root, "packages/contracts"), join(referenceNodeModules, "@t3tools/contracts"));
await ensureLink(resolve(t3Root, "packages/shared"), join(referenceNodeModules, "@t3tools/shared"));

const effectModule = (name) => pathToFileURL(resolve(referenceDeps, "effect/dist", `${name}.js`)).href;
const [Effect, Layer, Stream, DateTime, SqlClient] = await Promise.all([
  import(effectModule("Effect")),
  import(effectModule("Layer")),
  import(effectModule("Stream")),
  import(effectModule("DateTime")),
  import(pathToFileURL(resolve(referenceDeps, "effect/dist/sql/SqlClient.js")).href),
]);

const [contracts, EventSink, EventStore, ProjectionStore, ProjectStore, SqliteClient, Migrations] = await Promise.all([
  import(t3("packages/contracts/src/index.ts")),
  import(t3("apps/server/src/orchestration-v2/EventSink.ts")),
  import(t3("apps/server/src/orchestration-v2/EventStore.ts")),
  import(t3("apps/server/src/orchestration-v2/ProjectionStore.ts")),
  import(t3("apps/server/src/orchestration-v2/ProjectStore.ts")),
  import(t3("packages/shared/src/nodeSqliteClient.ts")),
  import(t3("apps/server/src/persistence/Migrations.ts")),
]);

const home = await mkdtemp(join(projectRoot, "artifacts/v2-proof/synthetic-home-"));
await writeFile(join(home, ".synthetic-t3-home"), "T3 native v2 compatibility proof; disposable data only.\n");
await mkdir(join(home, "attachments"), { recursive: true });
const dbPath = join(home, "statev2.sqlite");

const makeLayer = () => {
  const sql = SqliteClient.layer({ filename: dbPath });
  const stores = Layer.mergeAll(
    EventStore.layer,
    ProjectionStore.layer,
    ProjectStore.layer,
  );
  const storesWithSql = Layer.provideMerge(stores, sql);
  return Layer.provideMerge(EventSink.layer, storesWithSql);
};

const run = (effect, layer) => Effect.runPromise(Effect.provide(effect, layer));
const projectId = contracts.ProjectId.make("project:v2-proof");
const threadId = contracts.ThreadId.make("import:codex:session-v2-proof");
const providerInstanceId = contracts.ProviderInstanceId.make("codex");
const driver = contracts.ProviderDriverKind.make("codex");
const providerThreadId = contracts.ProviderThreadId.make("provider-thread:v2-proof");
const providerMessageId = contracts.MessageId.make("message:v2-proof:000001");
const userItemId = contracts.TurnItemId.make("turn-item:v2-proof:000001");
const importedAt = DateTime.makeUnsafe("2026-10-11T16:00:00.000Z");
const updatedAt = DateTime.makeUnsafe("2026-10-11T16:01:00.000Z");

const thread = {
  createdBy: "user",
  creationSource: "server",
  id: threadId,
  projectId,
  title: "Native v2 proof conversation",
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  linkedPullRequest: null,
  branchPullRequest: null,
  activeProviderThreadId: providerThreadId,
  historyOrigin: "v1_import",
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: importedAt,
  updatedAt,
  archivedAt: null,
  settledOverride: "settled",
  settledAt: updatedAt,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
  lastVisitedAt: null,
  deletedAt: null,
};

const providerThread = {
  id: providerThreadId,
  driver,
  providerInstanceId,
  providerSessionId: null,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver, nativeId: "source-session-v2-proof", strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  pendingBackgroundTasks: [],
  createdAt: importedAt,
  updatedAt,
};

const message = {
  createdBy: "user",
  creationSource: "server",
  id: providerMessageId,
  threadId,
  runId: null,
  nodeId: null,
  role: "user",
  text: "A representative imported message.",
  attachments: [],
  streaming: false,
  createdAt: importedAt,
  updatedAt: importedAt,
};

const turnItem = {
  id: userItemId,
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: importedAt,
  completedAt: importedAt,
  updatedAt: importedAt,
  createdBy: "user",
  creationSource: "server",
  type: "user_message",
  messageId: providerMessageId,
  inputIntent: "turn_start",
  text: message.text,
  attachments: [],
};

const createdEventId = contracts.EventId.make("t3-import:v2-proof:thread-created");
const importEvents = [
  { id: createdEventId, type: "thread.created", threadId, providerInstanceId, occurredAt: importedAt, payload: thread },
  { id: contracts.EventId.make("t3-import:v2-proof:message"), type: "message.updated", threadId, occurredAt: importedAt, payload: message },
  { id: contracts.EventId.make("t3-import:v2-proof:item"), type: "turn-item.updated", threadId, occurredAt: importedAt, payload: turnItem },
  { id: contracts.EventId.make("t3-import:v2-proof:provider-thread"), type: "provider-thread.updated", threadId, driver, providerInstanceId, occurredAt: updatedAt, payload: providerThread },
];

const projectCreated = {
  sequence: 1,
  eventId: contracts.EventId.make("event:v2-proof:project-created"),
  aggregateKind: "project",
  aggregateId: projectId,
  occurredAt: "2026-10-11T16:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "project.created",
  payload: {
    projectId,
    title: "Synthetic proof project",
    workspaceRoot: home,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-11T16:00:00.000Z",
    updatedAt: "2026-10-11T16:01:00.000Z",
  },
};

const seeded = Effect.gen(function* () {
  yield* Migrations.runMigrations();
  const eventSink = yield* EventSink.EventSinkV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  yield* projectStore.apply(projectCreated);
  const written = yield* eventSink.write({ events: importEvents });
  assert.equal(written.length, 4, "native sink must persist thread, message, item, and provider binding events");
  return written.map((item) => item.sequence);
});
const sequences = await run(seeded, makeLayer());

const reopened = Effect.gen(function* () {
  yield* Migrations.runMigrations();
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const eventStore = yield* EventStore.EventStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const threadProjection = yield* projectionStore.getThreadSnapshot(threadId);
  const messageCount = yield* projectionStore.getMessageCount(threadId);
  const records = yield* projectionStore.getThreadRecords(threadId, ["messages", "turnItems", "providerThreads"]);
  const storedEvents = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
  const metadata = yield* sql`SELECT schema_version, last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name = 'thread-projections'`;
  const eventMarkers = yield* sql`SELECT DISTINCT application_event_version FROM orchestration_events WHERE stream_id = ${threadId} ORDER BY application_event_version`;
  return { threadProjection, messageCount, records, storedEvents, metadata, eventMarkers };
});
const persisted = await run(reopened, makeLayer());
assert.equal(persisted.threadProjection.projection.thread.id, threadId);
assert.equal(persisted.threadProjection.projection.thread.historyOrigin, "v1_import");
assert.equal(persisted.messageCount, 1);
assert.equal(persisted.records.messages[0]?.text, message.text);
assert.equal(persisted.records.providerThreads[0]?.nativeThreadRef.nativeId, "source-session-v2-proof");
assert.equal(persisted.storedEvents.length, 4);
assert.equal(persisted.metadata[0]?.last_sequence, sequences.at(-1));
assert.deepEqual(persisted.eventMarkers.map((row) => row.application_event_version), [2]);

// Exercise the same-ID/no-write case against T3's projection. This deliberately
// does not call AgentSessionImporter or its project/history-origin guards.
const duplicateAttempt = Effect.gen(function* () {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const existing = yield* projectionStore.getThread(threadId);
  if (existing) return { outcome: "already-present", writeCount: 0 };
  const written = yield* eventSink.write({ events: importEvents });
  return { outcome: "written", writeCount: written.length };
});
const duplicate = await run(duplicateAttempt, makeLayer());
assert.deepEqual(duplicate, { outcome: "already-present", writeCount: 0 });

// First append a new message, then reuse the existing thread-created event ID.
// The second insert fails after the first insert has run; native EventSink's
// surrounding transaction must roll the entire batch back.
const rollbackAttempt = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  return yield* eventSink.write({
    events: [
      {
        id: contracts.EventId.make("t3-import:v2-proof:rollback-first"),
        type: "message.updated",
        threadId,
        occurredAt: updatedAt,
        payload: { ...message, id: contracts.MessageId.make("message:v2-proof:rollback"), text: "must roll back" },
      },
      { ...importEvents[0], payload: { ...thread, title: "duplicate id must fail" } },
    ],
  });
});
const rollbackExit = await Effect.runPromise(Effect.exit(Effect.provide(rollbackAttempt, makeLayer())));
assert.equal(rollbackExit._tag, "Failure", "reused event ID should reject the batch");

const afterRollback = await run(
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const eventStore = yield* EventStore.EventStoreV2;
    return {
      messageCount: yield* projectionStore.getMessageCount(threadId),
      messages: yield* eventStore.read({ threadId, eventType: "message.updated" }).pipe(Stream.runCollect),
    };
  }),
  makeLayer(),
);
assert.equal(afterRollback.messageCount, 1, "rollback must not leave a projected second message");
assert.equal(afterRollback.messages.length, 1, "rollback must not leave an event-only second message");

console.log(JSON.stringify({
  result: "PASS",
  sourceCommit: "ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e",
  syntheticHome: home,
  database: "statev2.sqlite",
  importedSequenceRange: [sequences[0], sequences.at(-1)],
  visibleThread: persisted.threadProjection.projection.thread.title,
  messageCount: persisted.messageCount,
  providerSession: persisted.records.providerThreads[0]?.nativeThreadRef.nativeId,
  closeReopen: "pass",
  duplicateDetection: duplicate.outcome,
  transactionRollback: rollbackExit._tag === "Failure" && afterRollback.messageCount === 1,
  projectionMetadata: persisted.metadata[0],
  applicationEventVersion: persisted.eventMarkers[0]?.application_event_version,
}, null, 2));
