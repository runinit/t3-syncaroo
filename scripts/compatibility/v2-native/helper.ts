import * as assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import * as DateTime from 'effect/DateTime';
import * as SqlClient from 'effect/sql/SqlClient';
import { ProjectId, ThreadId, ProviderThreadId, MessageId, TurnItemId, EventId } from '../../../artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/packages/contracts/src/baseSchemas.ts';
import { ProviderInstanceId, ProviderDriverKind } from '../../../artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/packages/contracts/src/providerInstance.ts';
import * as EventSink from '../../../artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/EventSink.ts';
import * as EventStore from '../../../artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/EventStore.ts';
import * as ProjectionStore from '../../../artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/ProjectionStore.ts';
import * as ProjectStore from '../../../artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/apps/server/src/orchestration-v2/ProjectStore.ts';
import * as SqliteClient from '../../../artifacts/t3-reference/t3code-ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e/packages/shared/src/nodeSqliteClient.ts';

const [dbPath] = process.argv.slice(2);
if (!dbPath) throw new Error('usage: node helper.mjs <synthetic-db-path>');
await mkdir(dirname(dbPath), { recursive: true });
const home = dirname(dbPath);
await writeFile(join(home, '.synthetic-t3-home'), 'Synthetic proof fixture; disposable data only.\n');
const makeLayer = () => {
  const sql = SqliteClient.layer({ filename: dbPath });
  const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer);
  const storesWithSql = Layer.provideMerge(stores, sql);
  return Layer.provideMerge(EventSink.layer, storesWithSql);
};
const run = (effect: any, layer: any) => Effect.runPromise(Effect.provide(effect, layer));
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
