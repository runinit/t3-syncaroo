import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const [helperPath, fixturePath, nodePath = process.execPath] = process.argv.slice(2);
if (!helperPath || !fixturePath) throw new Error('usage: node protocol-test.mjs <helper.mjs> <fixture.mjs> [node]');
const base = await mkdtemp(join(process.cwd(), 'artifacts/v2-native/protocol-test-'));
const run = (exe, args, input) => {
  const result = spawnSync(exe, args, { input, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  if (result.status !== 0) throw new Error(`${exe} ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  const lines = result.stdout.trim().split('\n');
  return JSON.parse(lines.at(-1));
};
const request = (dbPath, op, extra = {}) => ({ op, dbPath, ...extra });
const baseTime = '2026-10-11T16:00:00.000Z';
const updatedTime = '2026-10-11T16:01:00.000Z';
const projectId = 'project:v2-protocol';
const rollbackProjectId = 'project:v2-protocol-rollback';
const threadId = 'import:codex:session-v2-protocol';
const providerInstanceId = 'codex';
const providerThreadId = 'provider-thread:v2-protocol';
const projectEvent = {
  commandId: 'command:v2-protocol:project', commandType: 'project.create', acceptedAt: baseTime,
  event: { eventId: 'event:v2-protocol:project-created', aggregateKind: 'project', aggregateId: projectId,
    occurredAt: baseTime, commandId: null, causationEventId: null, correlationId: null, metadata: {}, type: 'project.created',
    payload: { projectId, title: 'Protocol proof project', workspaceRoot: base, defaultModelSelection: null, scripts: [], createdAt: baseTime, updatedAt: updatedTime } },
};
const thread = { createdBy:'user',creationSource:'server',id:threadId,projectId,title:'Native v2 protocol proof',providerInstanceId,
  modelSelection:{instanceId:providerInstanceId,model:'gpt-5.4'},runtimeMode:'full-access',interactionMode:'default',branch:null,worktreePath:null,
  linkedPullRequest:null,branchPullRequest:null,activeProviderThreadId:providerThreadId,historyOrigin:'v1_import',
  lineage:{parentThreadId:null,relationshipToParent:null,rootThreadId:threadId},forkedFrom:null,createdAt:baseTime,updatedAt:updatedTime,
  archivedAt:null,settledOverride:'settled',settledAt:updatedTime,unsettledAt:null,snoozedUntil:null,snoozedAt:null,pinnedAt:null,
  pinOrderKey:null,activeOrderKey:null,lastVisitedAt:null,deletedAt:null };
const message = {createdBy:'user',creationSource:'server',id:'message:v2-protocol:000001',threadId,runId:null,nodeId:null,role:'user',
  text:'A representative imported message.',attachments:[],streaming:false,createdAt:baseTime,updatedAt:baseTime};
const turnItem = {id:'turn-item:v2-protocol:000001',threadId,runId:null,nodeId:null,providerThreadId:null,providerTurnId:null,nativeItemRef:null,
  parentItemId:null,ordinal:1,status:'completed',title:null,startedAt:baseTime,completedAt:baseTime,updatedAt:baseTime,createdBy:'user',
  creationSource:'server',type:'user_message',messageId:message.id,inputIntent:'turn_start',text:message.text,attachments:[]};
const providerThread = {id:providerThreadId,driver:'codex',providerInstanceId,providerSessionId:null,appThreadId:threadId,ownerNodeId:null,
  nativeThreadRef:{driver:'codex',nativeId:'source-session-v2-protocol',strength:'strong'},nativeConversationHeadRef:null,status:'idle',
  firstRunOrdinal:null,lastRunOrdinal:null,handoffIds:[],forkedFrom:null,pendingBackgroundTasks:[],createdAt:baseTime,updatedAt:updatedTime};
const events = [
  {id:'t3-import:v2-protocol:thread-created',type:'thread.created',threadId,providerInstanceId,occurredAt:baseTime,payload:thread},
  {id:'t3-import:v2-protocol:message',type:'message.updated',threadId,occurredAt:baseTime,payload:message},
  {id:'t3-import:v2-protocol:item',type:'turn-item.updated',threadId,occurredAt:baseTime,payload:turnItem},
  {id:'t3-import:v2-protocol:provider-thread',type:'provider-thread.updated',threadId,driver:'codex',providerInstanceId,occurredAt:updatedTime,payload:providerThread},
];
const dbPath = join(base,'fresh','statev2.sqlite');
run(nodePath,[fixturePath,dbPath]);
const before = run(nodePath,[helperPath],JSON.stringify(request(dbPath,'inspect')));
assert.equal(before.ok,true); assert.equal(before.integrity,'ok'); assert.equal(before.profile.migrationRevision,61);
assert.equal(before.profile.requiredTablesPresent,true); assert.equal(before.profile.isV2Schema,true);
assert.equal(before.profile.hasV2ThreadProjectionTable,true);
const written = run(nodePath,[helperPath],JSON.stringify(request(dbPath,'write',{projectEvent,events})));
assert.equal(written.ok,true); assert.equal(written.outcome,'written'); assert.equal(written.projectCommitted,true);
assert.equal(written.storedSequenceRange.first,2); assert.equal(written.storedSequenceRange.last,5);
assert.equal(written.projections[0].threadId,threadId); assert.equal(written.projections[0].records.messages[0].text,message.text);
assert.equal(written.projections[0].records.providerThreads[0].nativeThreadRef.nativeId,'source-session-v2-protocol');
const after = run(nodePath,[helperPath],JSON.stringify(request(dbPath,'inspect',{threadIds:[threadId]})));
assert.equal(after.ok,true); assert.equal(after.threads[0].exists,true); assert.equal(after.threads[0].records.messages[0].text,message.text);
const duplicate = run(nodePath,[helperPath],JSON.stringify(request(dbPath,'write',{projectEvent,events})));
assert.equal(duplicate.ok,false); assert.equal(duplicate.outcome,'existing-thread-conflict');
const rollbackDb = join(base,'rollback','statev2.sqlite');
run(nodePath,[fixturePath,rollbackDb]);
const rollbackConnection = new DatabaseSync(rollbackDb);
rollbackConnection.exec("CREATE TRIGGER injected_projection_failure BEFORE INSERT ON orchestration_v2_projection_messages BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END");
rollbackConnection.close();
const rollbackProjectEvent = {
  ...projectEvent,
  commandId: 'command:v2-protocol:rollback',
  event: {
    ...projectEvent.event,
    eventId: 'event:v2-protocol:project-rollback',
    aggregateId: rollbackProjectId,
    payload: { ...projectEvent.event.payload, projectId: rollbackProjectId },
  },
};
const invalidEvents = [
  { ...events[0], payload: { ...thread, projectId: rollbackProjectId } },
  events[1],
];
const failed = run(nodePath, [helperPath], JSON.stringify(request(rollbackDb, 'write', {
  projectEvent: rollbackProjectEvent,
  events: invalidEvents,
})));
assert.equal(failed.ok,false); assert.equal(failed.projectCommitted,true); assert.equal(failed.projectCompensated,true);
const afterFailure = run(nodePath,[helperPath],JSON.stringify(request(rollbackDb,'inspect',{threadIds:[threadId],projectIds:[rollbackProjectId]})));
assert.equal(afterFailure.ok,true); assert.equal(afterFailure.threads[0].exists,false);
assert.equal(afterFailure.projects.length, 1);
assert.equal(afterFailure.projects[0].deletedAt != null, true);
const deletedAtBeforeReuse = afterFailure.projects[0].deletedAt;
const tombstoneDb = new DatabaseSync(rollbackDb);
tombstoneDb.exec('DROP TRIGGER injected_projection_failure');
const projectCreatedCountBefore = tombstoneDb.prepare(`SELECT COUNT(*) AS count FROM orchestration_events
  WHERE aggregate_kind = 'project' AND stream_id = ? AND event_type = 'project.created'
    AND application_event_version = 1`).get(rollbackProjectId).count;
tombstoneDb.close();
const tombstoneEvents = events.map((event) => ({
  ...event,
  ...(event.threadId ? { threadId } : {}),
  ...(event.type === 'thread.created' ? { payload: { ...thread, projectId: rollbackProjectId } }
    : event.type === 'message.updated' ? { payload: message }
      : event.type === 'turn-item.updated' ? { payload: turnItem }
        : event.type === 'provider-thread.updated' ? { payload: providerThread } : {}),
}));
const resurrectionAttempt = run(nodePath, [helperPath], JSON.stringify(request(rollbackDb, 'write', {
  projectEvent: rollbackProjectEvent, events: tombstoneEvents,
})));
assert.equal(resurrectionAttempt.ok, false);
const afterReuse = run(nodePath, [helperPath], JSON.stringify(request(rollbackDb, 'inspect', {
  threadIds: [threadId], projectIds: [rollbackProjectId],
})));
assert.equal(afterReuse.threads[0].exists, false);
assert.equal(afterReuse.projects[0].deletedAt, deletedAtBeforeReuse);
const verifyNoProjectRecreate = new DatabaseSync(rollbackDb);
const projectCreatedCountAfter = verifyNoProjectRecreate.prepare(`SELECT COUNT(*) AS count FROM orchestration_events
  WHERE aggregate_kind = 'project' AND stream_id = ? AND event_type = 'project.created'
    AND application_event_version = 1`).get(rollbackProjectId).count;
verifyNoProjectRecreate.close();
assert.equal(projectCreatedCountAfter, projectCreatedCountBefore);
async function rejectsBeforeWrite(name, badEvents, badProjectEvent, projectIds = []) {
  const db = join(base, name, 'statev2.sqlite');
  run(nodePath, [fixturePath, db]);
  const rejected = run(nodePath, [helperPath], JSON.stringify(request(db, 'write', {
    events: badEvents, ...(badProjectEvent ? { projectEvent: badProjectEvent } : {}),
  })));
  assert.equal(rejected.ok, false, `${name} must be rejected`);
  const state = run(nodePath, [helperPath], JSON.stringify(request(db, 'inspect', { threadIds: [threadId], projectIds })));
  assert.equal(state.threads[0].exists, false, `${name} must not create a thread`);
  assert.equal(state.projects.length, 0, `${name} must not create a project`);
}
await rejectsBeforeWrite('mismatched-thread-envelope', [events[0],
  { ...events[1], payload: { ...message, threadId: 'import:codex:foreign' } }], undefined);
await rejectsBeforeWrite('mismatched-created-thread-id', [
  { ...events[0], payload: { ...thread, id: 'import:codex:foreign' } }, ...events.slice(1),
], undefined);
const foreignProjectEvent = { ...projectEvent,
  event: { ...projectEvent.event, aggregateId: 'project:v2-protocol-other',
    payload: { ...projectEvent.event.payload, projectId: 'project:v2-protocol-other' } },
};
await rejectsBeforeWrite('mismatched-project-identity', events, foreignProjectEvent, ['project:v2-protocol-other']);
const invalidProjectCommand = { ...projectEvent, commandType: 'project.delete',
  event: { ...projectEvent.event, type: 'project.deleted',
    payload: { projectId, deletedAt: baseTime } },
};
await rejectsBeforeWrite('invalid-project-command', events, invalidProjectCommand, [projectId]);
const nodeVersion = spawnSync(nodePath, ['--version'], { encoding: 'utf8' }).stdout.trim();
console.log(JSON.stringify({result:'PASS',node:nodeVersion,inspect:true,write:true,existingThreadConflict:true,
  threadEnvelopeValidation:true,projectIdentityValidation:true,projectCreateRestriction:true,
  tombstonedProjectNotResurrected:true,closeReopen:true,rollback:true,projectCompensation:true}));
