import * as assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import * as DateTime from 'effect/DateTime';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as SqlClient from 'effect/sql/SqlClient';
import { CommandId, ProjectId, ThreadId, ProviderThreadId, MessageId, TurnItemId, EventId } from '../../../artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/packages/contracts/src/baseSchemas.ts';
import { ProviderInstanceId, ProviderDriverKind } from '../../../artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/packages/contracts/src/providerInstance.ts';
import * as EventSink from '../../../artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/EventSink.ts';
import * as EventStore from '../../../artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/EventStore.ts';
import * as ProjectionStore from '../../../artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/ProjectionStore.ts';
import * as ProjectStore from '../../../artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/ProjectStore.ts';
import { ApplicationProjectEvent } from '../../../artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/packages/contracts/src/applicationEvent.ts';
import { OrchestrationV2DomainEventJson } from '../../../artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/packages/contracts/src/orchestrationV2.ts';
import * as SqliteClient from '../../../artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/packages/shared/src/nodeSqliteClient.ts';

const makeLayer = () => {
  const sql = SqliteClient.layer({ filename: dbPath });
  const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer);
  const storesWithSql = Layer.provideMerge(stores, sql);
  return Layer.provideMerge(EventSink.layer, storesWithSql);
};
const run = (effect: any, layer: any) => Effect.runPromise(Effect.provide(effect, layer));
const makeLayerFor = (filename: string, readonly = false) => {
  const sql = SqliteClient.layer({ filename, readonly });
  const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer);
  return Layer.provideMerge(EventSink.layer, Layer.provideMerge(stores, sql));
};

function decodeEvents(input: unknown) {
  if (!Array.isArray(input) || input.length === 0) throw new Error('write requires a non-empty events array');
  return input.map((event) => Schema.decodeUnknownSync(OrchestrationV2DomainEventJson)(event));
}

function decodeProjectEvent(raw: any) {
  if (!raw || typeof raw !== 'object' || !raw.event || !raw.commandId || !raw.commandType || !raw.acceptedAt) {
    throw new Error('projectEvent requires commandId, commandType, acceptedAt, and event');
  }
  const decoded = Schema.decodeUnknownSync(ApplicationProjectEvent)({ ...raw.event, sequence: raw.event.sequence ?? 0 });
  const { sequence: _sequence, ...event } = decoded;
  return { commandId: CommandId.make(raw.commandId), commandType: raw.commandType,
    acceptedAt: DateTime.makeUnsafe(raw.acceptedAt), projectId: decoded.aggregateId, event };
}

async function inspect(request: any) {
  const program = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* EventStore.EventStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const migrations = yield* sql`SELECT migration_id AS migrationId, name FROM effect_sql_migrations ORDER BY migration_id`;
    const tables = yield* sql`SELECT name FROM sqlite_master WHERE type='table'`;
    const integrityRows = yield* sql`PRAGMA integrity_check`;
    const versions = yield* sql`SELECT DISTINCT application_event_version AS version FROM orchestration_events ORDER BY version`;
    const metadata = yield* sql`SELECT projection_name AS projectionName, schema_version AS schemaVersion, last_sequence AS lastSequence FROM orchestration_v2_projection_metadata ORDER BY projection_name`;
    const projects = [];
    for (const rawId of request.projectIds ?? []) {
      const project = yield* projectStore.get(ProjectId.make(rawId), { includeDeleted: true });
      if (Option.isSome(project)) projects.push(project.value);
    }
    const tableNames = new Set(tables.map((row: any) => row.name));
    const required = ['orchestration_events', 'orchestration_v2_projection_metadata', 'orchestration_v2_projection_threads'];
    const threads = [];
    for (const rawId of request.threadIds ?? []) {
      const threadId = ThreadId.make(rawId);
      const shell = yield* projections.getThreadShell(threadId);
      const records = shell ? yield* projections.getThreadRecords(threadId, ['messages', 'turnItems', 'plans', 'providerThreads', 'providerTurns']) : undefined;
      const events = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
      threads.push({ threadId, exists: shell !== null,
        ...(shell ? { thread: shell, records } : {}), events: events.map((stored: any) => ({ id: stored.event.id, sequence: stored.sequence })) });
    }
    return { ok: true, integrity: integrityRows[0]?.integrity_check ?? 'unknown',
      profile: { migrationRevision: migrations.at(-1)?.migrationId ?? 0,
        requiredTablesPresent: required.every((table) => tableNames.has(table)),
        hasV2ThreadProjectionTable: tableNames.has('orchestration_v2_projection_threads'),
        applicationEventVersions: versions.map((row: any) => row.version), isV2Schema: migrations.some((row: any) => row.migrationId === 61) },
      migrations, projectionMetadata: metadata, applicationEventVersions: versions.map((row: any) => row.version), projects, threads };
  });
  return run(program, makeLayerFor(request.dbPath, true));
}

async function writeRequest(request: any) {
  const events = decodeEvents(request.events);
  const threadIds = [...new Set(events.map((event: any) => event.threadId))];
  if (threadIds.length !== 1 || events.filter((event: any) => event.type === 'thread.created').length !== 1) {
    throw new Error('write accepts exactly one thread and one thread.created event');
  }
  const threadId = ThreadId.make(threadIds[0]);
  const threadCreated = events.find((event: any) => event.type === 'thread.created') as any;
  if (threadCreated.payload.id !== threadId) throw new Error('thread.created payload id does not match its event threadId');
  for (const event of events as any[]) {
    if (event.payload?.threadId !== undefined && event.payload.threadId !== event.threadId) {
      throw new Error(`${event.type} payload threadId does not match its event threadId`);
    }
    if (event.type === 'provider-thread.updated' && event.payload.appThreadId !== event.threadId) {
      throw new Error('provider-thread payload appThreadId does not match its event threadId');
    }
  }
  const ids = events.map((event: any) => event.id);
  if (new Set(ids).size !== ids.length) throw new Error('write contains duplicate event IDs');
  const project = request.projectEvent ? decodeProjectEvent(request.projectEvent) : undefined;
  if (project && (request.projectEvent.commandType !== 'project.create'
    || request.projectEvent.event.type !== 'project.created'
    || request.projectEvent.event.aggregateKind !== 'project'
    || request.projectEvent.event.payload.projectId !== project.projectId)) {
    throw new Error('projectEvent must be a consistent project.create / project.created event');
  }
  if (project && threadCreated.payload.projectId !== project.projectId) {
    throw new Error('thread.created projectId does not match projectEvent aggregateId');
  }
  const preflight = Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const shell = yield* projections.getThreadShell(threadId);
    if (shell) return { outcome: 'existing-thread-conflict', thread: shell };
    for (const id of ids) {
      const rows = yield* sql`SELECT event_id FROM orchestration_events WHERE event_id = ${id} LIMIT 1`;
      if (rows.length) throw new Error(`event ID already exists: ${id}`);
    }
    return { outcome: 'new' };
  });
  const existing = await run(preflight, makeLayerFor(request.dbPath, true));
  if (existing.outcome === 'existing-thread-conflict') {
    return { ok: false, outcome: 'existing-thread-conflict', error: 'thread ID is already present; caller must validate project/source/history identity', existingThread: existing.thread };
  }

  if (project) {
    const existingProject = await run(Effect.gen(function* () {
      const store = yield* ProjectStore.ProjectStoreV2;
      return yield* store.get(project.projectId, { includeDeleted: true });
    }), makeLayerFor(request.dbPath, true));
    if (Option.isSome(existingProject)) throw new Error('projectEvent target already exists');
  }
  const result = await run(Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    let projectCommitted = false;
    if (project) {
      const committed = yield* sink.commitProjectCommand(project);
      projectCommitted = committed.committed;
      if (!committed.committed) throw new Error('project command was not committed');
    }
    const storedExit = yield* Effect.match(sink.write({ events }), {
      onFailure: (error) => ({ _tag: 'Failure' as const, error }),
      onSuccess: (stored) => ({ _tag: 'Success' as const, stored }),
    });
    if (storedExit._tag === 'Failure') {
      let projectCompensated = false;
      let compensationError: string | undefined;
      if (project && projectCommitted) {
        try {
          const deletedAt = new Date().toISOString();
          const deleted = Schema.decodeUnknownSync(ApplicationProjectEvent)({
            sequence: 0, eventId: `event:compensate:${request.projectEvent.event.eventId}`,
            aggregateKind: 'project', aggregateId: project.projectId, occurredAt: deletedAt,
            commandId: null, causationEventId: request.projectEvent.event.eventId, correlationId: null,
            metadata: {}, type: 'project.deleted', payload: { projectId: project.projectId, deletedAt },
          });
          const { sequence: _sequence, ...unsequenced } = deleted;
          const compensation = yield* sink.commitProjectCommand({
            commandId: CommandId.make(`command:compensate:${request.projectEvent.commandId}`),
            commandType: 'project.delete', projectId: project.projectId,
            acceptedAt: DateTime.makeUnsafe(deletedAt), event: unsequenced,
          });
          projectCompensated = compensation.committed;
        } catch (error) { compensationError = String(error); }
      }
      return { ok: false, outcome: 'write-failed', error: String(storedExit.error), projectCommitted,
        projectCompensated, ...(compensationError ? { compensationError } : {}) };
    }
    const stored = storedExit.stored;
    return { ok: true, outcome: 'written', projectCommitted,
      storedSequenceRange: { first: stored[0]?.sequence, last: stored.at(-1)?.sequence } };
  }), makeLayerFor(request.dbPath));
  if (!result.ok) return result;
  const readback = await run(Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const snapshot = yield* projections.getThreadSnapshot(threadId);
    const records = yield* projections.getThreadRecords(threadId, ['messages', 'turnItems', 'plans', 'providerThreads', 'providerTurns']);
    return { snapshot, records };
  }), makeLayerFor(request.dbPath, true));
  return { ...result, projections: [{ threadId, ...readback }] };
}

async function dispatchRequest(request: any) {
  if (typeof request.dbPath !== 'string' || !request.dbPath) throw new Error('request requires dbPath');
  if (request.op === 'inspect') return inspect(request);
  if (request.op === 'write') return writeRequest(request);
  throw new Error(`unsupported operation: ${request.op}`);
}

let stdin = '';
if (!process.stdin.isTTY) for await (const chunk of process.stdin) stdin += chunk;
if (stdin.trim()) {
  try { console.log(JSON.stringify(await dispatchRequest(JSON.parse(stdin)))); }
  catch (error) { console.log(JSON.stringify({ ok: false, error: String(error) })); }
  process.exit(0);
}
const [dbPath] = process.argv.slice(2);
if (!dbPath) throw new Error('usage: node helper.mjs <synthetic-db-path>');
await mkdir(dirname(dbPath), { recursive: true });
const home = dirname(dbPath);
await writeFile(join(home, '.synthetic-t3-home'), 'Synthetic proof fixture; disposable data only.\n');
const projectId = ProjectId.make('project:v2-proof');
const threadId = ThreadId.make('import:codex:session-v2-proof');
const providerInstanceId = ProviderInstanceId.make('codex');
const driver = ProviderDriverKind.make('codex');
const providerThreadId = ProviderThreadId.make('provider-thread:v2-proof');
const messageId = MessageId.make('message:v2-proof:000001');
const itemId = TurnItemId.make('turn-item:v2-proof:000001');
const importedAt = DateTime.makeUnsafe('2026-10-11T16:00:00.000Z');
const updatedAt = DateTime.makeUnsafe('2026-10-11T16:01:00.000Z');
const thread = {
  createdBy:'user', creationSource:'server', id:threadId, projectId, title:'Native v2 packaged proof', providerInstanceId,
  modelSelection:{instanceId:providerInstanceId, model:'gpt-5.4'}, runtimeMode:'full-access', interactionMode:'default',
  branch:null, worktreePath:null, linkedPullRequest:null, branchPullRequest:null, activeProviderThreadId:providerThreadId,
  historyOrigin:'v1_import', lineage:{parentThreadId:null,relationshipToParent:null,rootThreadId:threadId}, forkedFrom:null,
  createdAt:importedAt,updatedAt,archivedAt:null,settledOverride:'settled',settledAt:updatedAt,unsettledAt:null,snoozedUntil:null,
  snoozedAt:null,pinnedAt:null,pinOrderKey:null,activeOrderKey:null,lastVisitedAt:null,deletedAt:null,
};
const providerThread = { id:providerThreadId,driver,providerInstanceId,providerSessionId:null,appThreadId:threadId,ownerNodeId:null,
  nativeThreadRef:{driver,nativeId:'source-session-v2-packaged',strength:'strong'},nativeConversationHeadRef:null,status:'idle',
  firstRunOrdinal:null,lastRunOrdinal:null,handoffIds:[],forkedFrom:null,pendingBackgroundTasks:[],createdAt:importedAt,updatedAt };
const message = {createdBy:'user',creationSource:'server',id:messageId,threadId,runId:null,nodeId:null,role:'user',
  text:'A representative imported message.',attachments:[],streaming:false,createdAt:importedAt,updatedAt:importedAt};
const turnItem = {id:itemId,threadId,runId:null,nodeId:null,providerThreadId:null,providerTurnId:null,nativeItemRef:null,parentItemId:null,
  ordinal:1,status:'completed',title:null,startedAt:importedAt,completedAt:importedAt,updatedAt:importedAt,createdBy:'user',
  creationSource:'server',type:'user_message',messageId,inputIntent:'turn_start',text:message.text,attachments:[]};
const events = [
  {id:EventId.make('t3-import:v2-proof:thread-created'),type:'thread.created',threadId,providerInstanceId,occurredAt:importedAt,payload:thread},
  {id:EventId.make('t3-import:v2-proof:message'),type:'message.updated',threadId,occurredAt:importedAt,payload:message},
  {id:EventId.make('t3-import:v2-proof:item'),type:'turn-item.updated',threadId,occurredAt:importedAt,payload:turnItem},
  {id:EventId.make('t3-import:v2-proof:provider-thread'),type:'provider-thread.updated',threadId,driver,providerInstanceId,occurredAt:updatedAt,payload:providerThread},
];
const projectCreated = {sequence:1,eventId:EventId.make('event:v2-proof:project-created'),aggregateKind:'project',aggregateId:projectId,
  occurredAt:'2026-10-11T16:00:00.000Z',commandId:null,causationEventId:null,correlationId:null,metadata:{},type:'project.created',payload:{
    projectId,title:'Synthetic proof project',workspaceRoot:home,defaultModelSelection:null,scripts:[],createdAt:'2026-10-11T16:00:00.000Z',updatedAt:'2026-10-11T16:01:00.000Z'}};
const write = Effect.gen(function*(){
  const projectStore=yield* ProjectStore.ProjectStoreV2; yield* projectStore.apply(projectCreated);
  const sink=yield* EventSink.EventSinkV2; return yield* sink.write({events});
});
const sequences = (await run(write,makeLayer())).map((r:any)=>r.sequence);
const read = Effect.gen(function*(){
  const projections=yield* ProjectionStore.ProjectionStoreV2; const eventStore=yield* EventStore.EventStoreV2; const sql=yield* SqlClient.SqlClient;
  const snapshot=yield* projections.getThreadSnapshot(threadId); const messageCount=yield* projections.getMessageCount(threadId);
  const records=yield* projections.getThreadRecords(threadId,['messages','turnItems','providerThreads']);
  const stored=yield* eventStore.read({threadId}).pipe(Stream.runCollect);
  const metadata=yield* sql`SELECT schema_version,last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name='thread-projections'`;
  const marker=yield* sql`SELECT DISTINCT application_event_version FROM orchestration_events WHERE stream_id=${threadId}`;
  return {snapshot,messageCount,records,stored,metadata,marker};
});
const persisted=await run(read,makeLayer());
assert.equal(persisted.snapshot.projection.thread.id,threadId); assert.equal(persisted.messageCount,1);
assert.equal(persisted.records.messages[0]?.text,message.text); assert.equal(persisted.records.providerThreads[0]?.nativeThreadRef.nativeId,'source-session-v2-packaged');
assert.equal(persisted.stored.length,4); assert.deepEqual(persisted.marker.map((r:any)=>r.application_event_version),[2]);
const duplicate=await run(Effect.gen(function*(){ const p=yield* ProjectionStore.ProjectionStoreV2; const e=yield* EventSink.EventSinkV2;
 const existing=yield* p.getThread(threadId); if(existing) return 'already-present'; yield* e.write({events}); return 'written'; }),makeLayer());
assert.equal(duplicate,'already-present');
const rollback=Effect.gen(function*(){const sink=yield* EventSink.EventSinkV2; return yield* sink.write({events:[
 {id:EventId.make('t3-import:v2-proof:rollback-first'),type:'message.updated',threadId,occurredAt:updatedAt,
  payload:{...message,id:MessageId.make('message:v2-proof:rollback'),text:'must roll back'}},events[0],]});});
const rollbackExit=await Effect.runPromise(Effect.exit(Effect.provide(rollback,makeLayer()))); assert.equal(rollbackExit._tag,'Failure');
const after=await run(Effect.gen(function*(){const p=yield* ProjectionStore.ProjectionStoreV2; return yield* p.getMessageCount(threadId);}),makeLayer());
assert.equal(after,1);
console.log(JSON.stringify({result:'PASS',sequences,visibleThread:persisted.snapshot.projection.thread.title,messageCount:persisted.messageCount,
 nativeProviderSession:persisted.records.providerThreads[0]?.nativeThreadRef.nativeId,closeReopen:true,duplicatePreflight:duplicate,
 rollback:rollbackExit._tag==='Failure'&&after===1,projectionMetadata:persisted.metadata[0],applicationEventVersion:2}));
