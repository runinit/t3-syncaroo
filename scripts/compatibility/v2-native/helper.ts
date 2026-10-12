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
import { CommandId, ProjectId, ThreadId, ProviderThreadId, MessageId, TurnItemId, EventId } from '../../../artifacts/t3-reference-2994/t3code-d07a07f33c0a1b317dea6234636976231c3688b5/packages/contracts/src/baseSchemas.ts';
import { ProviderInstanceId, ProviderDriverKind } from '../../../artifacts/t3-reference-2994/t3code-d07a07f33c0a1b317dea6234636976231c3688b5/packages/contracts/src/providerInstance.ts';
import * as EventSink from '../../../artifacts/t3-reference-2994/t3code-d07a07f33c0a1b317dea6234636976231c3688b5/apps/server/src/orchestration-v2/EventSink.ts';
import * as EventStore from '../../../artifacts/t3-reference-2994/t3code-d07a07f33c0a1b317dea6234636976231c3688b5/apps/server/src/orchestration-v2/EventStore.ts';
import * as ProjectionStore from '../../../artifacts/t3-reference-2994/t3code-d07a07f33c0a1b317dea6234636976231c3688b5/apps/server/src/orchestration-v2/ProjectionStore.ts';
import * as ProjectStore from '../../../artifacts/t3-reference-2994/t3code-d07a07f33c0a1b317dea6234636976231c3688b5/apps/server/src/orchestration-v2/ProjectStore.ts';
import { ApplicationProjectEvent } from '../../../artifacts/t3-reference-2994/t3code-d07a07f33c0a1b317dea6234636976231c3688b5/packages/contracts/src/applicationEvent.ts';
import { OrchestrationV2DomainEventJson } from '../../../artifacts/t3-reference-2994/t3code-d07a07f33c0a1b317dea6234636976231c3688b5/packages/contracts/src/orchestrationV2.ts';
import * as SqliteClient from '../../../artifacts/t3-reference-2994/t3code-d07a07f33c0a1b317dea6234636976231c3688b5/packages/shared/src/nodeSqliteClient.ts';

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

function canonicalJson(value: any): string {
  if (value && typeof value.toJSON === 'function') return canonicalJson(value.toJSON());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
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
  const selectedEventIds = request.selectedEventIds === undefined ? [] : request.selectedEventIds;
  if (!Array.isArray(selectedEventIds) || selectedEventIds.some((id: unknown) => typeof id !== 'string' || id.length === 0)
    || new Set(selectedEventIds).size !== selectedEventIds.length) {
    throw new Error('selectedEventIds must be an array of unique non-empty event IDs');
  }
  const selected = new Set<string>(selectedEventIds);
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
      const snapshot = shell ? yield* projections.getThreadSnapshot(threadId) : undefined;
      const records = shell ? yield* projections.getThreadRecords(threadId, ['messages', 'turnItems', 'plans', 'providerThreads', 'providerTurns']) : undefined;
      const recoveryRecords = shell && request.includeRecoveryRecords === true
        ? yield* projections.getThreadRecords(threadId, ['runs', 'attempts', 'nodes', 'checkpoints', 'checkpointScopes', 'contextHandoffs'])
        : undefined;
      const events = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
      threads.push({ threadId, exists: shell !== null,
        ...(shell ? { thread: shell, records } : {}), ...(snapshot ? { snapshot } : {}),
        ...(recoveryRecords ? { recoveryRecords } : {}),
        events: events.map((stored: any) => ({ id: stored.event.id, sequence: stored.sequence })),
        ...(selected.size > 0 ? { selectedEventDetails: events
          .filter((stored: any) => selected.has(stored.event.id))
          .map((stored: any) => ({ id: stored.event.id, sequence: stored.sequence, event: stored.event })) } : {}) });
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
    for (const event of events.filter((entry: any) => entry.type === 'provider-thread.updated') as any[]) {
      const owners = yield* sql`SELECT thread_id FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${event.payload.id} LIMIT 1`;
      if (owners.length) return { outcome: 'provider-thread-id-conflict', ownerThreadId: owners[0].thread_id };
    }
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
  if (existing.outcome === 'provider-thread-id-conflict') {
    return { ok: false, outcome: 'provider-thread-id-conflict', error: 'provider-thread ID is already owned by another projected thread', ownerThreadId: existing.ownerThreadId };
  }

  if (project) {
    const existingProject = await run(Effect.gen(function* () {
      const store = yield* ProjectStore.ProjectStoreV2;
      return yield* store.get(project.projectId, { includeDeleted: true });
    }), makeLayerFor(request.dbPath, true));
    if (Option.isSome(existingProject)) throw new Error('projectEvent target already exists');
  }
  const result = await run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    let projectCommitted = false;
    if (project) {
      const committed = yield* sink.commitProjectCommand(project);
      projectCommitted = committed.committed;
      if (!committed.committed) throw new Error('project command was not committed');
    }
    const storedExit = yield* sql.withTransaction(Effect.gen(function* () {
      for (const event of events.filter((entry: any) => entry.type === 'provider-thread.updated') as any[]) {
        const owners = yield* sql`SELECT thread_id FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${event.payload.id} LIMIT 1`;
        if (owners.length) return { _tag: 'Failure' as const, error: new Error('provider-thread-id-conflict') };
      }
      return yield* Effect.match(sink.write({ events }), {
        onFailure: (error) => ({ _tag: 'Failure' as const, error }),
        onSuccess: (stored) => ({ _tag: 'Success' as const, stored }),
      });
    }));
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
      return { ok: false, outcome: String(storedExit.error).includes('provider-thread-id-conflict') ? 'provider-thread-id-conflict' : 'write-failed', error: String(storedExit.error), projectCommitted,
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

const sameNativeRef = (actual: any, expected: any) => actual === null || expected === null
  ? actual === expected
  : actual?.driver === expected?.driver && actual?.nativeId === expected?.nativeId && actual?.strength === expected?.strength;

function appendConflict(reason: string, message: string) {
  return { ok: false, outcome: 'append-conflict', reason, error: message };
}

async function appendRequest(request: any) {
  const requiredStrings = ['threadId', 'projectId', 'providerInstanceId', 'providerThreadId', 'driver'];
  if (requiredStrings.some((key) => typeof request[key] !== 'string' || request[key].length === 0)
    || !Object.hasOwn(request, 'nativeThreadRef') || !Object.hasOwn(request, 'expectedConversationHeadRef')) {
    return appendConflict('invalid-identity', 'append requires complete expected thread and provider identity');
  }
  if (request.nativeThreadRef !== null && (request.nativeThreadRef?.driver !== request.driver
    || request.nativeThreadRef?.strength !== 'strong' || typeof request.nativeThreadRef?.nativeId !== 'string')) {
    return appendConflict('invalid-native-thread-reference', 'nativeThreadRef must be null or a matching strong reference');
  }
  const expectedHead = request.expectedConversationHeadRef;
  if (expectedHead !== null && (expectedHead?.driver !== request.driver || expectedHead?.strength !== 'strong'
    || typeof expectedHead?.nativeId !== 'string')) {
    return appendConflict('invalid-conversation-head-reference', 'expectedConversationHeadRef must be null or a matching strong reference');
  }
  if (request.nativeThreadRef === null && expectedHead !== null) {
    return appendConflict('invalid-conversation-head-reference', 'a null nativeThreadRef cannot have a conversation head');
  }

  let events: any[];
  try { events = decodeEvents(request.events); }
  catch (error) { return appendConflict('invalid-events', String(error)); }
  const threadId = ThreadId.make(request.threadId);
  const allowedTypes = new Set(['message.updated', 'turn-item.updated', 'plan.updated', 'provider-thread.updated']);
  if (events.some((event: any) => !allowedTypes.has(event.type))) {
    return appendConflict('forbidden-event-type', 'append only accepts message, turn-item, plan, and provider-thread updates');
  }
  if (events.filter((event: any) => event.type === 'provider-thread.updated').length > 1) {
    return appendConflict('ambiguous-provider-thread-update', 'append accepts at most one provider-thread update');
  }
  for (const event of events as any[]) {
    if (event.threadId !== threadId || (event.payload?.threadId !== undefined && event.payload.threadId !== threadId)
      || (event.payload?.projectId !== undefined && event.payload.projectId !== request.projectId)
      || (event.providerInstanceId !== undefined && event.providerInstanceId !== request.providerInstanceId)
      || (event.driver !== undefined && event.driver !== request.driver)
      || (event.payload?.providerInstanceId !== undefined && event.payload.providerInstanceId !== request.providerInstanceId)
      || (event.payload?.providerThreadId != null && event.payload.providerThreadId !== request.providerThreadId)) {
      return appendConflict('event-identity-mismatch', 'append event identity does not match the expected thread/project/provider');
    }
    if (event.type === 'provider-thread.updated') {
      const binding = event.payload;
      const desiredHead = binding.nativeConversationHeadRef;
      if (binding.id !== request.providerThreadId || binding.appThreadId !== threadId
        || binding.driver !== request.driver || binding.providerInstanceId !== request.providerInstanceId
        || !sameNativeRef(binding.nativeThreadRef, request.nativeThreadRef)
        || (request.nativeThreadRef === null && desiredHead !== null)
        || (desiredHead !== null && (desiredHead?.driver !== request.driver || desiredHead?.strength !== 'strong'
          || typeof desiredHead?.nativeId !== 'string'))) {
        return appendConflict('provider-thread-update-mismatch', 'provider-thread update must retain the active source reference and use a strong or null conversation head');
      }
    }
  }
  const ids = events.map((event: any) => event.id);
  if (new Set(ids).size !== ids.length) return appendConflict('duplicate-event-id', 'append request contains duplicate event IDs');

  let result: any;
  try {
    result = await run(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const shell = yield* projections.getThreadShell(threadId);
        if (!shell || shell.deletedAt != null) {
          return appendConflict('thread-not-live', 'append preflight conflict: thread-not-live');
        }
        if (shell.id !== threadId || shell.projectId !== ProjectId.make(request.projectId)
          || shell.providerInstanceId !== request.providerInstanceId
          || shell.activeProviderThreadId !== request.providerThreadId) {
          return appendConflict('thread-identity-mismatch', 'append preflight conflict: thread-identity-mismatch');
        }
        const records = yield* projections.getThreadRecords(threadId, ['providerThreads']);
        const bindings = records.providerThreads.filter((binding: any) => binding.id === request.providerThreadId);
        if (bindings.length !== 1) {
          return appendConflict('provider-binding-ambiguous', 'append preflight conflict: provider-binding-ambiguous');
        }
        const binding = bindings[0] as any;
        if (binding.appThreadId !== threadId || binding.providerInstanceId !== request.providerInstanceId
          || binding.driver !== request.driver || !sameNativeRef(binding.nativeThreadRef, request.nativeThreadRef)
          || !sameNativeRef(binding.nativeConversationHeadRef, expectedHead)) {
          return appendConflict('provider-identity-mismatch', 'append preflight conflict: provider-identity-mismatch');
        }
        for (const id of ids) {
          const rows = yield* sql`SELECT event_id FROM orchestration_events WHERE event_id = ${id} LIMIT 1`;
          if (rows.length) return appendConflict('event-id-exists', 'append preflight conflict: event-id-exists');
        }

        // This one-shot layer has no stream subscribers or outbox workers.
        // EventSink's nested savepoint therefore cannot publish to T3 before
        // this outer transaction commits. Do not reuse this in a running
        // T3/server composition, where EventSink notifications are live.
        const written = yield* Effect.match(
          Effect.flatMap(EventSink.EventSinkV2, (sink) => sink.write({ events })),
          { onFailure: (error) => ({ ok: false as const, outcome: 'write-failed' as const, error: String(error) }),
            onSuccess: (stored) => ({ ok: true as const, outcome: 'appended' as const,
              storedSequenceRange: { first: stored[0]?.sequence, last: stored.at(-1)?.sequence } }) },
        );
        return { ...written, threadId };
      }));
    }), makeLayerFor(request.dbPath));
  } catch (error: any) {
    if (error?.reason?._tag === 'LockTimeoutError') {
      return appendConflict('database-busy', 'native database is busy; retry the append after the competing writer finishes');
    }
    return appendConflict('append-transaction-failed', `append transaction failed: ${String(error)}`);
  }
  if (!result.ok) return result;
  const readback = await run(Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const snapshot = yield* projections.getThreadSnapshot(threadId);
    const records = yield* projections.getThreadRecords(threadId, ['messages', 'turnItems', 'plans', 'providerThreads', 'providerTurns']);
    return { snapshot, records };
  }), makeLayerFor(request.dbPath, true));
  return { ...result, threadId, projections: [{ threadId, ...readback }] };
}

const activeRunStatuses = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
const activeRequestStatuses = new Set(['pending', 'queued', 'running', 'waiting']);
const threadPayloadFields = new Set([
  'id', 'projectId', 'title', 'createdBy', 'creationSource', 'providerInstanceId', 'modelSelection', 'runtimeMode',
  'interactionMode', 'branch', 'worktreePath', 'linkedPullRequest', 'pullRequests', 'branchPullRequest',
  'activeProviderThreadId', 'historyOrigin', 'lineage', 'forkedFrom', 'createdAt', 'updatedAt', 'archivedAt',
  'settledOverride', 'settledAt', 'unsettledAt', 'snoozedUntil', 'snoozedAt', 'lastSnoozeWakeAt', 'limitRecovery',
  'pinnedAt', 'autoSettleDisabledAt', 'pinOrderKey', 'activeOrderKey', 'lastVisitedAt', 'titleRegeneration',
  'rollbackRequestId', 'rollbackFailure', 'deletedAt',
]);

function attachConflict(reason: string, error: string) {
  return { ok: false, outcome: 'attach-conflict', reason, error };
}

async function attachUpgradedBinding(request: any) {
  if (typeof request.threadId !== 'string' || !request.threadId || typeof request.projectId !== 'string'
    || !request.projectId || typeof request.providerInstanceId !== 'string' || !request.providerInstanceId
    || !request.expectedSnapshot || !request.event) {
    return attachConflict('invalid-identity', 'attach requires a verified thread snapshot and one binding event');
  }
  let events: any[];
  try { events = decodeEvents([request.event]); }
  catch (error) { return attachConflict('invalid-event', String(error)); }
  const event = events[0];
  const threadId = ThreadId.make(request.threadId);
  const binding = event.payload;
  const refValid = (ref: any) => ref === null || (ref?.driver === event.driver
    && ref?.strength === 'strong' && typeof ref?.nativeId === 'string' && ref.nativeId.length > 0);
  const emptyList = (value: any) => Array.isArray(value) && value.length === 0;
  if (event.type !== 'provider-thread.updated' || event.threadId !== threadId
    || event.driver !== binding.driver || event.providerInstanceId !== request.providerInstanceId
    || binding.appThreadId !== threadId || binding.providerInstanceId !== request.providerInstanceId
    || typeof event.driver !== 'string' || !event.driver
    || binding.status !== 'idle' || binding.providerSessionId !== null || binding.ownerNodeId !== null
    || binding.firstRunOrdinal !== null || binding.lastRunOrdinal !== null
    || !emptyList(binding.handoffIds) || binding.forkedFrom !== null || !emptyList(binding.pendingBackgroundTasks)
    || !refValid(binding.nativeThreadRef) || !refValid(binding.nativeConversationHeadRef)
    || (binding.nativeThreadRef === null && binding.nativeConversationHeadRef !== null)) {
    return attachConflict('invalid-binding-event', 'attach accepts one idle app binding with exact provider identity and null or strong source references');
  }
  const expected = request.expectedSnapshot;
  if (!expected?.thread || !Array.isArray(expected.messages) || !Array.isArray(expected.turnItems)
    || !Array.isArray(expected.plans) || !emptyList(expected.providerThreads) || !emptyList(expected.providerTurns)) {
    return attachConflict('invalid-expected-snapshot', 'expectedSnapshot must contain the verified shell and complete history with empty binding records');
  }
  const expectedThread = expected.thread;
  if (expectedThread.id !== threadId || expectedThread.projectId !== request.projectId
    || expectedThread.providerInstanceId !== request.providerInstanceId || expectedThread.historyOrigin !== 'v1_import'
    || expectedThread.activeProviderThreadId != null || expectedThread.deletedAt != null) {
    return attachConflict('invalid-expected-shell', 'expected snapshot is not an unbound live v1-import shell for the requested identities');
  }

  let result: any;
  try {
    result = await run(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventStore = yield* EventStore.EventStoreV2;
      return yield* sql.withTransaction(Effect.gen(function* () {
        const shell = yield* projections.getThreadShell(threadId);
        if (!shell || shell.deletedAt != null || shell.projectId !== request.projectId
          || shell.providerInstanceId !== request.providerInstanceId || shell.historyOrigin !== 'v1_import') {
          return attachConflict('shell-identity-conflict', 'target shell is missing, deleted, or no longer matches the verified v1 import owner');
        }
        const snapshot = yield* projections.getThreadSnapshot(threadId);
        const state: any = snapshot?.projection;
        if (!state?.thread || state.runs.some((entry: any) => activeRunStatuses.has(entry.status))
          || state.attempts.some((entry: any) => activeRunStatuses.has(entry.status))
          || state.runtimeRequests.some((entry: any) => activeRequestStatuses.has(entry.status))) {
          return attachConflict('thread-active', 'target shell has active or indeterminate orchestration state');
        }
        const records = yield* projections.getThreadRecords(threadId, ['messages', 'turnItems', 'plans', 'providerThreads', 'providerTurns']);
        const stored = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
        const prior = stored.find((entry: any) => entry.event.id === event.id);
        if (prior) {
          const exactBinding = shell.activeProviderThreadId === binding.id && records.providerThreads.length === 1
            && canonicalJson(records.providerThreads[0]) === canonicalJson(binding) && records.providerTurns.length === 0;
          if (exactBinding && prior.event.type === event.type && prior.event.driver === event.driver
            && prior.event.providerInstanceId === event.providerInstanceId
            && canonicalJson(prior.event.payload) === canonicalJson(binding)) {
            return { ok: true, outcome: 'already-attached', threadId: request.threadId,
              storedSequences: [{ eventId: event.id, threadId: request.threadId, sequence: prior.sequence }],
              storedSequenceRange: { first: prior.sequence, last: prior.sequence } };
          }
          return attachConflict('event-id-conflict', 'attach event ID already belongs to different native state');
        }
        if (shell.activeProviderThreadId != null || records.providerThreads.length || records.providerTurns.length) {
          return attachConflict('binding-already-present', 'target shell already has provider bindings or provider turns');
        }
        const actual = { thread: shell, messages: records.messages, turnItems: records.turnItems,
          plans: records.plans, providerThreads: records.providerThreads, providerTurns: records.providerTurns };
        if (canonicalJson(actual) !== canonicalJson(expected)) {
          return attachConflict('history-changed', 'target shell or projected history changed after source reconciliation inspected it');
        }
        const owners = yield* sql`SELECT thread_id FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${binding.id} LIMIT 1`;
        if (owners.length) return attachConflict('provider-thread-id-conflict', 'T3-local provider-thread ID is already owned by another task');
        const eventRows = yield* sql`SELECT event_id FROM orchestration_events WHERE event_id = ${event.id} LIMIT 1`;
        if (eventRows.length) return attachConflict('event-id-conflict', 'attach event ID already exists outside this exact binding transition');
        const written = yield* Effect.match(Effect.flatMap(EventSink.EventSinkV2, (sink) => sink.write({ events })), {
          onFailure: (error) => ({ ok: false as const, outcome: 'write-failed' as const, error: String(error) }),
          onSuccess: (entries) => ({ ok: true as const, outcome: 'attached' as const, stored: entries }),
        });
        if (!written.ok) return written;
        const entry = written.stored[0]!;
        return { ok: true as const, outcome: 'attached' as const, threadId: request.threadId,
          storedSequences: [{ eventId: event.id, threadId: request.threadId, sequence: entry.sequence }],
          storedSequenceRange: { first: entry.sequence, last: entry.sequence } };
      }));
    }), makeLayerFor(request.dbPath));
  } catch (error) {
    return { ok: false, outcome: 'write-failed', error: String(error) };
  }
  if (!result.ok || result.outcome === 'already-attached') return result;
  const readback = await run(Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const snapshot = yield* projections.getThreadSnapshot(threadId);
    const records = yield* projections.getThreadRecords(threadId, ['providerThreads', 'providerTurns']);
    return { snapshot, records };
  }), makeLayerFor(request.dbPath, true));
  const projected = readback.snapshot?.projection;
  if (projected?.thread?.activeProviderThreadId !== binding.id || readback.records.providerThreads.length !== 1
    || canonicalJson(readback.records.providerThreads[0]) !== canonicalJson(binding) || readback.records.providerTurns.length !== 0) {
    return { ok: false, outcome: 'readback-conflict', error: 'native binding write committed without the exact provider projection readback' };
  }
  return { ...result, projections: [{ threadId: request.threadId, ...readback }] };
}

function replaceConflict(reason: string, message: string) {
  return { ok: false, outcome: 'replace-conflict', reason, error: message };
}

async function replaceRequest(request: any) {
  const required = ['replacementThreadId', 'projectId', 'providerInstanceId', 'replacementProviderThreadId', 'driver'];
  if (required.some((key) => typeof request[key] !== 'string' || request[key].length === 0)
    || !Array.isArray(request.oldThreadIds) || request.oldThreadIds.length === 0
    || !Array.isArray(request.oldBindings) || request.oldBindings.length !== request.oldThreadIds.length
    || !Object.hasOwn(request, 'nativeThreadRef') || !Object.hasOwn(request, 'expectedConversationHeadRef')) {
    return replaceConflict('invalid-identity', 'replace requires project, provider, old-thread, and replacement identities');
  }
  const oldThreadIds = request.oldThreadIds as string[];
  const bindingsByThreadId = new Map((request.oldBindings as any[]).map((entry) => [entry.threadId, entry]));
  if (new Set(oldThreadIds).size !== oldThreadIds.length || oldThreadIds.includes(request.replacementThreadId)
    || bindingsByThreadId.size !== oldThreadIds.length || oldThreadIds.some((id) => !bindingsByThreadId.has(id))) {
    return replaceConflict('invalid-thread-set', 'replace requires unique old thread IDs distinct from the replacement');
  }
  const refIsValid = (ref: any) => ref === null || (ref?.driver === request.driver
    && ref?.strength === 'strong' && typeof ref?.nativeId === 'string' && ref.nativeId.length > 0);
  if (!refIsValid(request.nativeThreadRef) || !refIsValid(request.expectedConversationHeadRef)
    || (request.nativeThreadRef === null && request.expectedConversationHeadRef !== null)) {
    return replaceConflict('invalid-continuation-reference', 'replace continuation references must be null or strong references for the selected provider');
  }
  for (const oldBinding of request.oldBindings as any[]) {
    if (typeof oldBinding.providerThreadId !== 'string' || !oldBinding.providerThreadId
      || !refIsValid(oldBinding.nativeThreadRef) || !refIsValid(oldBinding.expectedConversationHeadRef)
      || !sameNativeRef(oldBinding.nativeThreadRef, request.nativeThreadRef)) {
      return replaceConflict('invalid-old-binding', 'every old thread requires its exact provider binding and the same native source session');
    }
  }
  const transferRuntimeFrom = request.transferRuntimeFromThreadId ?? oldThreadIds[0];
  if (!oldThreadIds.includes(transferRuntimeFrom)) {
    return replaceConflict('invalid-runtime-owner', 'runtime transfer source must be one of the retired threads');
  }
  const transferBinding = bindingsByThreadId.get(transferRuntimeFrom) as any;
  if (!sameNativeRef(transferBinding.expectedConversationHeadRef, request.expectedConversationHeadRef)) {
    return replaceConflict('invalid-runtime-owner', 'replacement conversation head must match the selected old provider binding');
  }
  let events: any[];
  try { events = decodeEvents(request.events); }
  catch (error) { return replaceConflict('invalid-events', String(error)); }
  const replacementId = ThreadId.make(request.replacementThreadId);
  const createEvents = events.filter((event: any) => event.type === 'thread.created');
  const deleteEvents = events.filter((event: any) => event.type === 'thread.deleted');
  if (createEvents.length !== 1 || createEvents[0].threadId !== replacementId
    || createEvents[0].payload.id !== replacementId
    || deleteEvents.length !== oldThreadIds.length
    || new Set(deleteEvents.map((event: any) => event.threadId)).size !== oldThreadIds.length
    || oldThreadIds.some((id) => !deleteEvents.some((event: any) => event.threadId === id))) {
    return replaceConflict('invalid-event-set', 'replace requires one replacement thread and one tombstone for every old thread');
  }
  if (deleteEvents.some((event: any) => event.providerInstanceId !== request.providerInstanceId
    || event.payload.projectId !== request.projectId
    || event.payload.providerInstanceId !== request.providerInstanceId)) {
    return replaceConflict('event-identity-mismatch', 'every retired thread envelope and shell must belong to the requested project and provider instance');
  }
  const replacementEvents = events.filter((event: any) => event.threadId === replacementId);
  const tombstonesValid = deleteEvents.every((event: any) => event.payload.id === event.threadId
    && String(event.payload.deletedAt) === String(event.occurredAt)
    && String(event.payload.updatedAt) === String(event.occurredAt));
  const shellIdentityValid = createEvents[0].payload.projectId === request.projectId
    && createEvents[0].payload.providerInstanceId === request.providerInstanceId
    && createEvents[0].payload.activeProviderThreadId === request.replacementProviderThreadId;
  if (replacementEvents.length + deleteEvents.length !== events.length
    || !tombstonesValid || !shellIdentityValid) {
    return replaceConflict('event-identity-mismatch', 'replace events must preserve requested identity and carry full updated tombstones');
  }
  const providerEvents = replacementEvents.filter((event: any) => event.type === 'provider-thread.updated');
  if (providerEvents.length !== 1) return replaceConflict('provider-binding-ambiguous', 'replacement must contain exactly one native provider binding');
  const binding = providerEvents[0].payload;
  if (providerEvents[0].driver !== request.driver || providerEvents[0].providerInstanceId !== request.providerInstanceId
    || binding.id !== request.replacementProviderThreadId || binding.appThreadId !== replacementId
    || binding.driver !== request.driver || binding.providerInstanceId !== request.providerInstanceId
    || !sameNativeRef(binding.nativeThreadRef, request.nativeThreadRef)
    || !sameNativeRef(binding.nativeConversationHeadRef, request.expectedConversationHeadRef)) {
    return replaceConflict('replacement-provider-mismatch', 'replacement provider binding does not retain the selected native source session and conversation head');
  }
  for (const event of replacementEvents as any[]) {
    if ((event.payload?.threadId !== undefined && event.payload.threadId !== replacementId)
      || (event.payload?.projectId !== undefined && event.payload.projectId !== request.projectId)
      || (event.providerInstanceId !== undefined && event.providerInstanceId !== request.providerInstanceId)) {
      return replaceConflict('event-identity-mismatch', 'replacement event payload identity does not match the requested project and thread');
    }
  }
  const eventIds = events.map((event: any) => event.id);
  if (new Set(eventIds).size !== eventIds.length) return replaceConflict('duplicate-event-id', 'replace request contains duplicate event IDs');

  let result: any;
  try {
    result = await run(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const projectStore = yield* ProjectStore.ProjectStoreV2;
      return yield* sql.withTransaction(Effect.gen(function* () {
        const existingShell = yield* projections.getThreadShell(replacementId);
        if (existingShell) {
          const records = yield* projections.getThreadRecords(replacementId, ['providerThreads']);
          const stored = yield* eventStore.read({ threadId: replacementId }).pipe(Stream.runCollect);
          const storedById = new Map(stored.map((entry: any) => [entry.event.id, entry.sequence]));
          for (const rawId of oldThreadIds) {
            const oldEvents = yield* eventStore.read({ threadId: ThreadId.make(rawId) }).pipe(Stream.runCollect);
            for (const entry of oldEvents as any[]) storedById.set(entry.event.id, entry.sequence);
          }
          const exactEventsPresent = events.every((event: any) => storedById.has(event.id));
          const oldRetired = events.filter((event: any) => event.type === 'thread.deleted')
            .every((event: any) => oldThreadIds.includes(event.threadId) && storedById.has(event.id));
          const replacementBinding = records.providerThreads.find((entry: any) => entry.id === request.replacementProviderThreadId);
          if (exactEventsPresent && oldRetired && existingShell.projectId === request.projectId
            && existingShell.providerInstanceId === request.providerInstanceId
            && replacementBinding?.appThreadId === replacementId
            && sameNativeRef(replacementBinding.nativeThreadRef, request.nativeThreadRef)
            && sameNativeRef(replacementBinding.nativeConversationHeadRef, request.expectedConversationHeadRef)) {
            const sequences = events.map((event: any) => Number(storedById.get(event.id)));
            const storedSequences = events.map((event: any) => ({ eventId: event.id, threadId: event.threadId,
              sequence: Number(storedById.get(event.id)) }));
            return { ok: true, outcome: 'already-replaced', replacementThreadId: request.replacementThreadId,
              storedSequences, storedSequenceRange: { first: Math.min(...sequences), last: Math.max(...sequences) } };
          }
          return replaceConflict('replacement-identity-conflict', 'replacement ID already exists without matching committed replacement evidence');
        }

        const projectOption = yield* projectStore.get(ProjectId.make(request.projectId), { includeDeleted: true });
        if (Option.isNone(projectOption) || projectOption.value.deletedAt != null) {
          return replaceConflict('project-not-live', 'replacement project is missing or deleted');
        }
        for (const rawId of oldThreadIds) {
          const expectedOldBinding = bindingsByThreadId.get(rawId) as any;
          const oldId = ThreadId.make(rawId);
          const shell = yield* projections.getThreadShell(oldId);
          if (!shell || shell.deletedAt != null) return replaceConflict('old-thread-not-live', `old thread is missing or deleted: ${rawId}`);
          if (shell.projectId !== request.projectId || shell.providerInstanceId !== request.providerInstanceId
            || shell.activeProviderThreadId !== expectedOldBinding.providerThreadId) {
            return replaceConflict('old-thread-identity-conflict', `old thread identity does not match the replacement owner: ${rawId}`);
          }
          const tombstone = deleteEvents.find((event: any) => event.threadId === rawId);
          const expectedTombstone = Object.fromEntries(Object.entries(shell)
            .filter(([key]) => threadPayloadFields.has(key)));
          expectedTombstone.deletedAt = tombstone?.occurredAt;
          expectedTombstone.titleRegeneration = null;
          expectedTombstone.updatedAt = tombstone?.occurredAt;
          if (!tombstone || canonicalJson(tombstone.payload) !== canonicalJson(expectedTombstone)) {
            return replaceConflict('old-thread-payload-conflict', `retired thread tombstone does not preserve the current native shell: ${rawId}`);
          }
          const snapshot = yield* projections.getThreadSnapshot(oldId);
          const state: any = snapshot.projection;
          if (state.runs.some((run: any) => activeRunStatuses.has(run.status))
            || state.attempts.some((attempt: any) => activeRunStatuses.has(attempt.status))
            || state.runtimeRequests.some((entry: any) => activeRequestStatuses.has(entry.status))) {
            return replaceConflict('old-thread-active', `old thread has active orchestration state: ${rawId}`);
          }
          const records = yield* projections.getThreadRecords(oldId, ['providerThreads']);
          const bindings = records.providerThreads.filter((entry: any) => entry.id === expectedOldBinding.providerThreadId);
          if (bindings.length !== 1 || bindings[0].appThreadId !== oldId
            || bindings[0].providerInstanceId !== request.providerInstanceId || bindings[0].driver !== request.driver
            || bindings[0].status !== 'idle' || !sameNativeRef(bindings[0].nativeThreadRef, expectedOldBinding.nativeThreadRef)
            || !sameNativeRef(bindings[0].nativeConversationHeadRef, expectedOldBinding.expectedConversationHeadRef)) {
            return replaceConflict('old-provider-identity-conflict', `old provider binding is active, missing, ambiguous, or changed: ${rawId}`);
          }
        }
        for (const id of eventIds) {
          const rows = yield* sql`SELECT event_id FROM orchestration_events WHERE event_id = ${id} LIMIT 1`;
          if (rows.length) return replaceConflict('event-id-exists', `replace event ID already exists: ${id}`);
        }
        const providerThreadOwners = yield* sql`SELECT thread_id FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${request.replacementProviderThreadId} LIMIT 1`;
        if (providerThreadOwners.length) {
          return replaceConflict('provider-thread-id-conflict', 'replacement T3-local provider-thread ID is already owned by another task');
        }
        const runtimeRows: any[] = [];
        for (const rawId of oldThreadIds) {
          const rows = yield* sql`SELECT thread_id FROM provider_session_runtime WHERE thread_id = ${rawId}`;
          runtimeRows.push(...rows);
        }
        const replacementRuntime = yield* sql`SELECT thread_id FROM provider_session_runtime WHERE thread_id = ${request.replacementThreadId}`;
        if (replacementRuntime.length > 0) {
          return replaceConflict('runtime-owner-ambiguous', 'provider runtime ownership cannot transfer uniquely to the replacement');
        }

        // The one-shot helper has no T3 event subscribers; the enclosing SQL
        // transaction contains EventSink's savepoint and all replacement events.
        const written = yield* Effect.match(
          Effect.flatMap(EventSink.EventSinkV2, (sink) => sink.write({ events })),
          { onFailure: (error) => ({ ok: false as const, outcome: 'write-failed' as const, error: String(error) }),
            onSuccess: (stored) => ({ ok: true as const, outcome: 'replaced' as const,
              stored, storedSequenceRange: { first: stored[0]?.sequence, last: stored.at(-1)?.sequence } }) },
        );
        if (!written.ok) return written;

        // Runtime cursors are not projections. Transfer their existing native
        // row only when the source binding itself passed the exact-ref check.
        for (const runtimeRow of runtimeRows) {
          const priorId = String(runtimeRow.thread_id);
          if (priorId === transferRuntimeFrom) {
            yield* sql`UPDATE provider_session_runtime SET thread_id = ${request.replacementThreadId} WHERE thread_id = ${priorId}`;
          } else {
            yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = ${priorId}`;
          }
        }
        return { ok: true as const, outcome: 'replaced' as const, replacementThreadId: request.replacementThreadId,
          storedSequences: written.stored.map((entry: any) => ({ eventId: entry.event.id, threadId: entry.event.threadId, sequence: entry.sequence })),
          storedSequenceRange: written.storedSequenceRange };
      }));
    }), makeLayerFor(request.dbPath));
  } catch (error) {
    return { ok: false, outcome: 'write-failed', error: String(error) };
  }
  if (!result.ok || result.outcome === 'already-replaced') return result;
  const readback = await run(Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const result: any[] = [];
    const eventStore = yield* EventStore.EventStoreV2;
    for (const rawId of [...oldThreadIds, request.replacementThreadId]) {
      const threadId = ThreadId.make(rawId);
      const shell = yield* projections.getThreadShell(threadId);
      const snapshot = shell ? yield* projections.getThreadSnapshot(threadId) : undefined;
      const records = shell ? yield* projections.getThreadRecords(threadId, ['messages', 'turnItems', 'plans', 'providerThreads', 'providerTurns']) : undefined;
      const events = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
      result.push({ threadId: rawId, ...(snapshot ? { snapshot } : {}), ...(records ? { records } : {}),
        events: events.map((entry: any) => ({ id: entry.event.id, type: entry.event.type })) });
    }
    return result;
  }), makeLayerFor(request.dbPath, true));
  const tombstones = new Map(events.filter((event: any) => event.type === 'thread.deleted')
    .map((event: any) => [event.threadId, event.id]));
  const oldRetired = readback.filter((entry: any) => oldThreadIds.includes(entry.threadId))
    .every((entry: any) => !entry.snapshot && entry.events.some((event: any) => event.id === tombstones.get(entry.threadId) && event.type === 'thread.deleted'));
  const replacement = readback.find((entry: any) => entry.threadId === request.replacementThreadId);
  if (!oldRetired || !replacement?.snapshot?.projection?.thread
    || replacement.snapshot.projection.thread.projectId !== request.projectId
    || replacement.snapshot.projection.thread.providerInstanceId !== request.providerInstanceId
    || !replacement.records.providerThreads.some((entry: any) => entry.id === request.replacementProviderThreadId
      && sameNativeRef(entry.nativeThreadRef, request.nativeThreadRef)
      && sameNativeRef(entry.nativeConversationHeadRef, request.expectedConversationHeadRef))) {
    return { ok: false, outcome: 'readback-conflict', error: 'native replacement committed without the expected projected task and transferred continuation identity' };
  }
  return { ...result, projections: readback };
}

async function dispatchRequest(request: any) {
  if (typeof request.dbPath !== 'string' || !request.dbPath) throw new Error('request requires dbPath');
  if (request.op === 'inspect') return inspect(request);
  if (request.op === 'write') return writeRequest(request);
  if (request.op === 'append') return appendRequest(request);
  if (request.op === 'attach-upgraded-binding') return attachUpgradedBinding(request);
  if (request.op === 'replace') return replaceRequest(request);
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
