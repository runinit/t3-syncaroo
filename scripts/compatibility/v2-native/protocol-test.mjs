import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
assert.equal(written.ok,true,JSON.stringify(written)); assert.equal(written.outcome,'written'); assert.equal(written.projectCommitted,true);
assert.equal(written.storedSequenceRange.first,2); assert.equal(written.storedSequenceRange.last,5);
assert.equal(written.projections[0].threadId,threadId); assert.equal(written.projections[0].records.messages[0].text,message.text);
assert.equal(written.projections[0].records.providerThreads[0].nativeThreadRef.nativeId,'source-session-v2-protocol');
const after = run(nodePath,[helperPath],JSON.stringify(request(dbPath,'inspect',{threadIds:[threadId]})));
assert.equal(after.ok,true); assert.equal(after.threads[0].exists,true); assert.equal(after.threads[0].records.messages[0].text,message.text);
assert.deepEqual(after.threads[0].events.map((event) => event.id), events.map((event) => event.id));
assert.deepEqual(after.threads[0].events.map((event) => event.sequence), [2,3,4,5]);
const nativeRef = providerThread.nativeThreadRef;
const nextHeadRef = { driver: 'codex', nativeId: 'source-head:v2-protocol:next', strength: 'strong' };
const appendedMessage = { ...message, id: 'message:v2-protocol:000002', text: 'A newly settled source turn.' };
const appendEvents = [
  { id: 't3-import:v2-protocol:append-message', type: 'message.updated', threadId, providerInstanceId,
    occurredAt: updatedTime, payload: appendedMessage },
  { id: 't3-import:v2-protocol:append-provider-thread', type: 'provider-thread.updated', threadId,
    driver: 'codex', providerInstanceId, occurredAt: updatedTime,
    payload: { ...providerThread, nativeConversationHeadRef: nextHeadRef, updatedAt: updatedTime } },
];
const appendRequest = (eventsToAppend = appendEvents, overrides = {}) => request(dbPath, 'append', {
  threadId, projectId, providerInstanceId, providerThreadId, driver: 'codex',
  nativeThreadRef: nativeRef, expectedConversationHeadRef: null, events: eventsToAppend, ...overrides,
});
const appended = run(nodePath, [helperPath], JSON.stringify(appendRequest()));
assert.equal(appended.ok, true); assert.equal(appended.outcome, 'appended');
assert.deepEqual(appended.storedSequenceRange, { first: 6, last: 7 });
assert.equal(appended.projections[0].records.messages.length, 2);
assert.equal(appended.projections[0].records.messages[1].text, appendedMessage.text);
assert.equal(appended.projections[0].records.providerThreads[0].nativeConversationHeadRef.nativeId, nextHeadRef.nativeId);
const afterAppend = run(nodePath, [helperPath], JSON.stringify(request(dbPath, 'inspect', { threadIds: [threadId] })));
assert.equal(afterAppend.threads[0].events.length, 6);
assert.equal(afterAppend.threads[0].events.at(-1).id, appendEvents[1].id);
const duplicateAppend = run(nodePath, [helperPath], JSON.stringify(appendRequest(appendEvents, { expectedConversationHeadRef: nextHeadRef })));
assert.equal(duplicateAppend.ok, false); assert.equal(duplicateAppend.outcome, 'append-conflict');
assert.equal(duplicateAppend.reason, 'event-id-exists');
const duplicateWithinBatch = run(nodePath, [helperPath], JSON.stringify(appendRequest(
  [appendEvents[0], appendEvents[0]], { expectedConversationHeadRef: nextHeadRef },
)));
assert.equal(duplicateWithinBatch.ok, false); assert.equal(duplicateWithinBatch.outcome, 'append-conflict');
assert.equal(duplicateWithinBatch.reason, 'duplicate-event-id');
const afterDuplicateBatch = run(nodePath, [helperPath], JSON.stringify(request(dbPath, 'inspect', { threadIds: [threadId] })));
assert.deepEqual(afterDuplicateBatch.threads[0].events.map((event) => event.id), afterAppend.threads[0].events.map((event) => event.id));
assert.equal(afterDuplicateBatch.threads[0].records.providerThreads[0].nativeConversationHeadRef.nativeId, nextHeadRef.nativeId);
async function appendRejectedWithoutEvents(name, overrides, invalidEvents = appendEvents) {
  const beforeIds = afterAppend.threads[0].events.map((event) => event.id);
  const rejected = run(nodePath, [helperPath], JSON.stringify(appendRequest(invalidEvents, overrides)));
  assert.equal(rejected.ok, false, `${name} must be rejected`);
  const state = run(nodePath, [helperPath], JSON.stringify(request(dbPath, 'inspect', { threadIds: [threadId] })));
  assert.deepEqual(state.threads[0].events.map((event) => event.id), beforeIds, `${name} must not append events`);
}
await appendRejectedWithoutEvents('project-mismatch', { projectId: 'project:foreign', expectedConversationHeadRef: nextHeadRef });
await appendRejectedWithoutEvents('provider-mismatch', { providerInstanceId: 'claude-code', expectedConversationHeadRef: nextHeadRef });
await appendRejectedWithoutEvents('native-thread-reference-mismatch', {
  nativeThreadRef: { ...nativeRef, nativeId: 'other-source-session' }, expectedConversationHeadRef: nextHeadRef,
});
await appendRejectedWithoutEvents('stale-conversation-head', { expectedConversationHeadRef: null });
await appendRejectedWithoutEvents('forbidden-thread-delete', { expectedConversationHeadRef: nextHeadRef }, [
  { id: 't3-import:v2-protocol:append-delete', type: 'thread.deleted', threadId, occurredAt: updatedTime, payload: thread },
]);
await appendRejectedWithoutEvents('mismatched-append-payload-thread', { expectedConversationHeadRef: nextHeadRef }, [
  { ...appendEvents[0], id: 't3-import:v2-protocol:append-foreign-thread', payload: { ...appendedMessage,
    id: 'message:v2-protocol:foreign-thread', threadId: 'import:codex:foreign' } },
]);
await appendRejectedWithoutEvents('ambiguous-provider-thread-update', { expectedConversationHeadRef: nextHeadRef }, [
  appendEvents[1], { ...appendEvents[1], id: 't3-import:v2-protocol:append-provider-thread-2' },
]);
const appendFailureConnection = new DatabaseSync(dbPath);
appendFailureConnection.exec("CREATE TRIGGER injected_append_failure BEFORE INSERT ON orchestration_v2_projection_messages BEGIN SELECT RAISE(ABORT, 'injected append failure'); END");
appendFailureConnection.close();
const failingAppendEvent = { id: 't3-import:v2-protocol:append-rollback', type: 'message.updated', threadId, providerInstanceId,
  occurredAt: updatedTime, payload: { ...appendedMessage, id: 'message:v2-protocol:rollback', text: 'must roll back' } };
const failedAppend = run(nodePath, [helperPath], JSON.stringify(appendRequest([failingAppendEvent], { expectedConversationHeadRef: nextHeadRef })));
assert.equal(failedAppend.ok, false); assert.equal(failedAppend.outcome, 'write-failed');
const afterFailedAppend = run(nodePath, [helperPath], JSON.stringify(request(dbPath, 'inspect', { threadIds: [threadId] })));
assert.deepEqual(afterFailedAppend.threads[0].events.map((event) => event.id), afterAppend.threads[0].events.map((event) => event.id));
assert.equal(afterFailedAppend.threads[0].records.messages.length, 2);
const removeAppendFailure = new DatabaseSync(dbPath); removeAppendFailure.exec('DROP TRIGGER injected_append_failure'); removeAppendFailure.close();
const noResumeDb = join(base, 'no-resume', 'statev2.sqlite');
run(nodePath, [fixturePath, noResumeDb]);
const noResumeEvents = events.map((event) => event.type === 'provider-thread.updated'
  ? { ...event, payload: { ...providerThread, nativeThreadRef: null } } : event);
const noResumeWrite = run(nodePath, [helperPath], JSON.stringify(request(noResumeDb, 'write', { projectEvent, events: noResumeEvents })));
assert.equal(noResumeWrite.ok, true);
const noResumeAppend = run(nodePath, [helperPath], JSON.stringify(request(noResumeDb, 'append', {
  threadId, projectId, providerInstanceId, providerThreadId, driver: 'codex', nativeThreadRef: null,
  expectedConversationHeadRef: null,
  events: [{ ...appendEvents[0], id: 't3-import:v2-protocol:no-resume-append',
    payload: { ...appendedMessage, id: 'message:v2-protocol:no-resume', text: 'No-resume sync append.' } }],
})));
assert.equal(noResumeAppend.ok, true); assert.equal(noResumeAppend.outcome, 'appended');
const noResumeMismatch = run(nodePath, [helperPath], JSON.stringify(request(noResumeDb, 'append', {
  threadId, projectId, providerInstanceId, providerThreadId, driver: 'codex', nativeThreadRef: nativeRef,
  expectedConversationHeadRef: null,
  events: [{ ...appendEvents[0], id: 't3-import:v2-protocol:no-resume-mismatch',
    payload: { ...appendedMessage, id: 'message:v2-protocol:no-resume-mismatch' } }],
})));
assert.equal(noResumeMismatch.ok, false); assert.equal(noResumeMismatch.outcome, 'append-conflict');

// Two helpers racing from the same observed head must not both append. A large
// preflight batch makes the old split read/write scopes overlap reliably; the
// native writable transaction must serialize the check and sink write.
const runAsync = (exe, args, input) => new Promise((resolve, reject) => {
  const child = spawn(exe, args, { env: { ...process.env, NODE_PATH: '' } });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (status) => {
    if (status !== 0) return reject(new Error(`${exe} ${args.join(' ')} failed (${status}): ${stderr}`));
    try { resolve(JSON.parse(stdout.trim().split('\n').at(-1))); } catch (error) { reject(error); }
  });
  child.stdin.end(input);
});
const racingAppend = (suffix) => {
  const batch = Array.from({ length: 160 }, (_, index) => {
    const sequence = String(index + 1).padStart(3, '0');
    return { id: `t3-import:v2-protocol:race-${suffix}:event-${sequence}`, type: 'message.updated', threadId,
      providerInstanceId, occurredAt: updatedTime,
      payload: { ...message, id: `message:v2-protocol:race-${suffix}:${sequence}`, text: `Concurrent append ${suffix}/${sequence}` } };
  });
  const desiredHead = { driver: 'codex', nativeId: `source-head:v2-protocol:race-${suffix}`, strength: 'strong' };
  batch.push({ id: `t3-import:v2-protocol:race-${suffix}:provider-thread`, type: 'provider-thread.updated', threadId,
    driver: 'codex', providerInstanceId, occurredAt: updatedTime,
    payload: { ...providerThread, nativeConversationHeadRef: desiredHead, updatedAt: updatedTime } });
  return appendRequest(batch, { expectedConversationHeadRef: nextHeadRef });
};
const raceResults = await Promise.all(['a', 'b'].map((suffix) =>
  runAsync(nodePath, [helperPath], JSON.stringify(racingAppend(suffix))),
));
assert.equal(raceResults.filter((result) => result.ok).length, 1,
  'only one append may commit from the same expected conversation head');
assert.equal(raceResults.filter((result) => result.outcome === 'append-conflict').length, 1,
  `the contending loser must return a structured conflict: ${JSON.stringify(raceResults.map((result) => ({ outcome: result.outcome, reason: result.reason, error: result.error })))}`);
assert.equal(['database-busy', 'provider-identity-mismatch'].includes(raceResults.find((result) => !result.ok).reason), true,
  'the loser must either observe the committed head or report a retryable writer conflict');
const raceWinner = raceResults.find((result) => result.ok);
const raceState = run(nodePath, [helperPath], JSON.stringify(request(dbPath, 'inspect', { threadIds: [threadId] })));
assert.equal(raceState.threads[0].events.length, afterAppend.threads[0].events.length + 161,
  'only the winning append batch may persist');
assert.match(raceState.threads[0].records.providerThreads[0].nativeConversationHeadRef.nativeId,
  /^source-head:v2-protocol:race-[ab]$/);
const raceAEvents = raceState.threads[0].events.filter((event) => event.id.includes(':race-a:')).length;
assert.equal(raceAEvents === 161 || raceAEvents === 0, true, 'only one complete race batch may persist');
assert.equal(raceWinner.outcome, 'appended');
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
assert.equal(afterFailure.ok,true,JSON.stringify(afterFailure)); assert.equal(afterFailure.threads[0].exists,false);
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
const upgradedDb = join(base, 'attach-upgraded-binding', 'statev2.sqlite');
run(nodePath, [fixturePath, upgradedDb]);
const upgradedThread = { ...thread, activeProviderThreadId: null };
const upgradedEvents = events.filter((event) => event.type !== 'provider-thread.updated')
  .map((event) => event.type === 'thread.created' ? { ...event, payload: upgradedThread } : event);
assert.equal(run(nodePath, [helperPath], JSON.stringify(request(upgradedDb, 'write', {
  projectEvent, events: upgradedEvents,
}))).ok, true);
const upgradedState = run(nodePath, [helperPath], JSON.stringify(request(upgradedDb, 'inspect', { threadIds: [threadId] })));
const expectedSnapshot = { thread: upgradedState.threads[0].thread,
  messages: upgradedState.threads[0].records.messages, turnItems: upgradedState.threads[0].records.turnItems,
  plans: upgradedState.threads[0].records.plans, providerThreads: [], providerTurns: [] };
const attachedProviderThreadId = 'provider-thread:v2-protocol:upgraded';
const attachedProviderThread = { ...providerThread, id: attachedProviderThreadId, appThreadId: threadId,
  nativeThreadRef: null, nativeConversationHeadRef: null };
const attachEvent = { id: 't3-import:v2-protocol:attach-upgraded', type: 'provider-thread.updated', threadId,
  driver: 'codex', providerInstanceId, occurredAt: updatedTime, payload: attachedProviderThread };
const attachRequest = (overrides = {}) => request(upgradedDb, 'attach-upgraded-binding', {
  threadId, projectId, providerInstanceId, expectedSnapshot, event: attachEvent, ...overrides,
});
const changedAttach = run(nodePath, [helperPath], JSON.stringify(attachRequest({ expectedSnapshot: {
  ...expectedSnapshot, messages: [{ ...expectedSnapshot.messages[0], text: 'changed after inspected proof' }],
} })));
assert.equal(changedAttach.ok, false); assert.equal(changedAttach.outcome, 'attach-conflict');
const attached = run(nodePath, [helperPath], JSON.stringify(attachRequest()));
assert.equal(attached.ok, true, JSON.stringify(attached)); assert.equal(attached.outcome, 'attached');
assert.equal(attached.storedSequences[0].eventId, attachEvent.id);
const attachedRetry = run(nodePath, [helperPath], JSON.stringify(attachRequest()));
assert.equal(attachedRetry.ok, true, JSON.stringify(attachedRetry)); assert.equal(attachedRetry.outcome, 'already-attached');
const attachedState = run(nodePath, [helperPath], JSON.stringify(request(upgradedDb, 'inspect', { threadIds: [threadId] })));
assert.equal(attachedState.threads[0].thread.activeProviderThreadId, attachedProviderThreadId);
assert.equal(attachedState.threads[0].records.providerThreads.length, 1);
assert.equal(attachedState.threads[0].records.providerThreads[0].nativeThreadRef, null);
const bindingCollisionDb = join(base, 'binding-id-collision', 'statev2.sqlite');
run(nodePath, [fixturePath, bindingCollisionDb]);
assert.equal(run(nodePath, [helperPath], JSON.stringify(request(bindingCollisionDb, 'write', { projectEvent, events }))).ok, true);
const secondThreadId = 'import:codex:session-v2-protocol-second';
const collidingEvents = events.map((entry, index) => {
  const payload = { ...entry.payload };
  if (entry.type === 'thread.created') Object.assign(payload, { id: secondThreadId, activeProviderThreadId: providerThreadId,
    lineage: { ...thread.lineage, rootThreadId: secondThreadId } });
  if (entry.type === 'message.updated') Object.assign(payload, { id: 'message:v2-protocol:second', threadId: secondThreadId });
  if (entry.type === 'turn-item.updated') Object.assign(payload, { id: 'turn-item:v2-protocol:second', threadId: secondThreadId,
    messageId: 'message:v2-protocol:second' });
  if (entry.type === 'provider-thread.updated') Object.assign(payload, { appThreadId: secondThreadId });
  return { ...entry, id: `t3-import:v2-protocol:second:${index}`, threadId: secondThreadId, payload };
});
const providerIdCollision = run(nodePath, [helperPath], JSON.stringify(request(bindingCollisionDb, 'write', { events: collidingEvents })));
assert.equal(providerIdCollision.ok, false); assert.equal(providerIdCollision.outcome, 'provider-thread-id-conflict');
const afterProviderIdCollision = run(nodePath, [helperPath], JSON.stringify(request(bindingCollisionDb, 'inspect', {
  threadIds: [threadId, secondThreadId],
})));
assert.equal(afterProviderIdCollision.threads[0].records.providerThreads[0].appThreadId, threadId);
assert.equal(afterProviderIdCollision.threads[1].exists, false);
const replacementThreadId = 'import:codex:session-v2-protocol-replacement';
const replacementProviderThreadId = 'provider-thread:v2-protocol-replacement';
const replacementThread = { ...thread, id: replacementThreadId, title: 'Replaced native v2 protocol proof',
  activeProviderThreadId: replacementProviderThreadId, createdAt: updatedTime, updatedAt: updatedTime,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: replacementThreadId } };
const replacementMessage = { ...appendedMessage, id: 'message:v2-protocol:replacement', threadId: replacementThreadId };
const replacementItem = { ...turnItem, id: 'turn-item:v2-protocol:replacement', threadId: replacementThreadId,
  messageId: replacementMessage.id, text: replacementMessage.text };
const replacementProviderThread = { ...providerThread, id: replacementProviderThreadId,
  appThreadId: replacementThreadId, nativeConversationHeadRef: null, updatedAt: updatedTime };
const replacementEvents = [
  { id: 't3-import:v2-protocol:replacement-created', type: 'thread.created', threadId: replacementThreadId,
    providerInstanceId, occurredAt: updatedTime, payload: replacementThread },
  { id: 't3-import:v2-protocol:replacement-message', type: 'message.updated', threadId: replacementThreadId,
    occurredAt: updatedTime, payload: replacementMessage },
  { id: 't3-import:v2-protocol:replacement-item', type: 'turn-item.updated', threadId: replacementThreadId,
    occurredAt: updatedTime, payload: replacementItem },
  { id: 't3-import:v2-protocol:replacement-provider-thread', type: 'provider-thread.updated', threadId: replacementThreadId,
    driver: 'codex', providerInstanceId, occurredAt: updatedTime, payload: replacementProviderThread },
  { id: 't3-import:v2-protocol:retire-old-thread', type: 'thread.deleted', threadId, providerInstanceId,
    occurredAt: updatedTime, payload: { ...thread, deletedAt: updatedTime, titleRegeneration: null, updatedAt: updatedTime } },
];
const replaceRequest = (targetDb = dbPath, eventsToReplace = replacementEvents, overrides = {}) => request(targetDb, 'replace', {
  oldThreadIds: [threadId], replacementThreadId, projectId, providerInstanceId,
  oldBindings: [{ threadId, providerThreadId, nativeThreadRef: nativeRef, expectedConversationHeadRef: null }],
  transferRuntimeFromThreadId: threadId, replacementProviderThreadId, driver: 'codex', nativeThreadRef: nativeRef,
  expectedConversationHeadRef: null, events: eventsToReplace, ...overrides,
});
const replacementEventsForCurrentShell = (targetDb) => {
  const current = run(nodePath, [helperPath], JSON.stringify(request(targetDb, 'inspect', { threadIds: [threadId] }))).threads[0].thread;
  const events = structuredClone(replacementEvents);
  events.at(-1).payload = { ...current, deletedAt: updatedTime, titleRegeneration: null, updatedAt: updatedTime };
  return events;
};
const rejectsReplacementBeforeWrite = (name, mutate) => {
  const targetDb = join(base, name, 'statev2.sqlite');
  run(nodePath, [fixturePath, targetDb]);
  run(nodePath, [helperPath], JSON.stringify(request(targetDb, 'write', { projectEvent, events })));
  const changed = replacementEventsForCurrentShell(targetDb);
  mutate(changed.at(-1));
  const rejected = run(nodePath, [helperPath], JSON.stringify(replaceRequest(targetDb, changed)));
  assert.equal(rejected.ok, false, `${name} must be rejected`);
  assert.equal(rejected.outcome, 'replace-conflict', `${name} must return a structured conflict`);
  const state = run(nodePath, [helperPath], JSON.stringify(request(targetDb, 'inspect', { threadIds: [threadId, replacementThreadId] })));
  assert.equal(state.threads.find((entry) => entry.threadId === threadId).thread.deletedAt, null, `${name} must retain old shell`);
  assert.equal(state.threads.find((entry) => entry.threadId === replacementThreadId).exists, false, `${name} must not create replacement`);
};
rejectsReplacementBeforeWrite('replace-foreign-delete-envelope', (event) => { event.providerInstanceId = 'foreign-provider-instance'; });
rejectsReplacementBeforeWrite('replace-changed-title', (event) => { event.payload.title = 'Unrelated native title'; });
rejectsReplacementBeforeWrite('replace-changed-model', (event) => { event.payload.modelSelection = { ...event.payload.modelSelection, model: 'foreign-model' }; });
rejectsReplacementBeforeWrite('replace-changed-branch', (event) => { event.payload.branch = 'foreign-branch'; });
rejectsReplacementBeforeWrite('replace-changed-lineage', (event) => { event.payload.lineage = { ...event.payload.lineage, rootThreadId: 'foreign-root' }; });
const replacementDb = join(base, 'replace-happy-path', 'statev2.sqlite');
run(nodePath, [fixturePath, replacementDb]);
run(nodePath, [helperPath], JSON.stringify(request(replacementDb, 'write', { projectEvent, events })));
const validReplacementEvents = replacementEventsForCurrentShell(replacementDb);
const replaced = run(nodePath, [helperPath], JSON.stringify(replaceRequest(replacementDb, validReplacementEvents)));
assert.equal(replaced.ok, true, JSON.stringify(replaced)); assert.equal(replaced.outcome, 'replaced');
assert.equal(replaced.replacementThreadId, replacementThreadId);
assert.equal(replaced.storedSequenceRange.last - replaced.storedSequenceRange.first, replacementEvents.length - 1);
assert.equal(replaced.projections.find((entry) => entry.threadId === replacementThreadId).records.messages.at(-1).text,
  replacementMessage.text);
const afterReplace = run(nodePath, [helperPath], JSON.stringify(request(replacementDb, 'inspect', {
  threadIds: [threadId, replacementThreadId],
})));
assert.equal(afterReplace.threads.find((entry) => entry.threadId === threadId).exists, false);
assert.equal(afterReplace.threads.find((entry) => entry.threadId === threadId).events.at(-1).id,
  't3-import:v2-protocol:retire-old-thread');
assert.equal(afterReplace.threads.find((entry) => entry.threadId === replacementThreadId).exists, true);
const countAfterReplace = afterReplace.threads.flatMap((entry) => entry.events).length;
const repeatedReplace = run(nodePath, [helperPath], JSON.stringify(replaceRequest(replacementDb, validReplacementEvents)));
assert.equal(repeatedReplace.ok, true, JSON.stringify(repeatedReplace)); assert.equal(repeatedReplace.outcome, 'already-replaced');
const afterRepeatedReplace = run(nodePath, [helperPath], JSON.stringify(request(replacementDb, 'inspect', {
  threadIds: [threadId, replacementThreadId],
})));
assert.equal(afterRepeatedReplace.threads.flatMap((entry) => entry.events).length, countAfterReplace);
const badHeadDb = join(base, 'replace-stale-head', 'statev2.sqlite');
run(nodePath, [fixturePath, badHeadDb]);
run(nodePath, [helperPath], JSON.stringify(request(badHeadDb, 'write', { projectEvent, events })));
run(nodePath, [helperPath], JSON.stringify(request(badHeadDb, 'append', {
  threadId, projectId, providerInstanceId, providerThreadId, driver: 'codex',
  nativeThreadRef: nativeRef, expectedConversationHeadRef: null, events: appendEvents,
})));
const badHeadReplacement = run(nodePath, [helperPath], JSON.stringify(replaceRequest(badHeadDb, replacementEventsForCurrentShell(badHeadDb))));
assert.equal(badHeadReplacement.ok, false); assert.equal(badHeadReplacement.outcome, 'replace-conflict');
const afterBadHead = run(nodePath, [helperPath], JSON.stringify(request(badHeadDb, 'inspect', {
  threadIds: [threadId, replacementThreadId],
})));
assert.equal(afterBadHead.threads[0].thread.deletedAt, null);
assert.equal(afterBadHead.threads[1].exists, false);
const nodeVersion = spawnSync(nodePath, ['--version'], { encoding: 'utf8' }).stdout.trim();
console.log(JSON.stringify({result:'PASS',node:nodeVersion,inspect:true,write:true,append:true,appendIdentityConflicts:true,
  duplicateAppendEventIds:true,appendRollback:true,existingThreadConflict:true,
  threadEnvelopeValidation:true,projectIdentityValidation:true,projectCreateRestriction:true,noResumeAppend:true,
  competingWriterAppend:true,tombstonedProjectNotResurrected:true,atomicReplacement:true,replacementRetry:true,
  replacementIdentityConflicts:true,replacementTombstoneGuard:true,upgradedBindingAttach:true,attachHistoryCas:true,attachRetry:true,
  globalProviderThreadIdConflict:true,closeReopen:true,rollback:true,projectCompensation:true}));
