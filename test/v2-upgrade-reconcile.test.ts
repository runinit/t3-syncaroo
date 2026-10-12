import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileUpgradedImport, v2UpgradeSequenceEvidence, type UpgradeThreadCandidate } from "../src/target/v2/reconcile.js";
import { encodeCanonicalHistory, projectedHistoryMatches } from "../src/target/v2/history.js";
import { canonicalThread } from "./helpers.js";

const nativeHelper = fileURLToPath(new URL("../vendor/t3-v2-native-helper.mjs", import.meta.url));
const legacyFixtureRunner = fileURLToPath(new URL("../scripts/compatibility/v2-native/legacy-upgrade-fixture.mjs", import.meta.url));
const t3SourceDir = process.env.T3_V2_T3_SOURCE_DIR;
const t3DependencyRoot = process.env.T3_V2_T3_DEPENDENCY_ROOT;

const source = {
  provider: "codex" as const,
  sourceSessionId: "11111111-1111-4111-8111-111111111111",
  sourceKey: "codex:11111111-1111-4111-8111-111111111111",
  expectedThreadId: "11111111-1111-4111-8111-111111111111",
  projectId: "project-1",
};
const mapping = {
  provider: "codex" as const,
  sourceSessionId: "11111111-1111-4111-8111-111111111111",
  sourceKey: "codex:11111111-1111-4111-8111-111111111111",
  threadId: "11111111-1111-4111-8111-111111111111",
  projectId: "project-1",
};

function candidate(overrides: Partial<UpgradeThreadCandidate> = {}): UpgradeThreadCandidate {
  return {
    threadId: source.expectedThreadId,
    projectId: "project-1",
    historyOrigin: "v1_import",
    historyVerification: "exact",
    nativeBinding: "absent",
    ...overrides,
  };
}

describe("v2 upgrade reconciliation", () => {
  it("recognizes one converted task from source identity, project, full history, and exact native binding", () => {
    expect(reconcileUpgradedImport({ source, candidates: [candidate({ nativeBinding: "exact" })], mapping })).toMatchObject({
      status: "matched", threadId: source.expectedThreadId, recoveredLedger: false,
    });
  });

  it("requires safe native attachment before recovering an exact converted history", () => {
    expect(reconcileUpgradedImport({ source, candidates: [candidate()] })).toMatchObject({
      status: "needs-binding", threadId: source.expectedThreadId, recoveredLedger: true, action: expect.any(String),
    });
  });

  it("recovers an exact converted history when its source binding is already present", () => {
    expect(reconcileUpgradedImport({ source, candidates: [candidate({ nativeBinding: "exact" })] })).toMatchObject({
      status: "recoverable", threadId: source.expectedThreadId, recoveredLedger: true, action: expect.any(String),
    });
  });

  it("does not attach a converted history with a divergent provider binding", () => {
    expect(reconcileUpgradedImport({ source, candidates: [candidate({ nativeBinding: "diverged" })], mapping }))
      .toMatchObject({ status: "conflict", action: expect.any(String) });
  });

  it("leaves unrelated upgraded tasks available for ordinary planning", () => {
    expect(reconcileUpgradedImport({ source, candidates: [candidate({ threadId: "other-thread", historyVerification: "diverged" })] }))
      .toEqual({ status: "absent" });
  });

  it("refuses to recover a saved mapping with a different source identity", () => {
    expect(reconcileUpgradedImport({ source, candidates: [candidate()], mapping: { ...mapping, sourceKey: "codex:other" } }))
      .toMatchObject({ status: "conflict", action: expect.any(String) });
  });

  it.each([
    ["changed history", [candidate({ historyVerification: "diverged" })]],
    ["incomplete rich history", [candidate({ historyVerification: "incomplete" })]],
    ["wrong project", [candidate({ projectId: "other-project" })]],
    ["ambiguous candidates", [candidate(), candidate({ threadId: "another-thread" })]],
  ])("returns an actionable conflict for %s", (_reason, candidates) => {
    expect(reconcileUpgradedImport({ source, candidates })).toMatchObject({ status: "conflict", action: expect.any(String) });
  });

  it("uses v2 application sequence semantics when retained v1 rows trail the v2 stream", () => {
    const evidence = v2UpgradeSequenceEvidence({
      events: [
        { sequence: 12, applicationEventVersion: 2, aggregateKind: "thread" },
        { sequence: 14, applicationEventVersion: 2, aggregateKind: "project" },
        { sequence: 17, applicationEventVersion: 1, aggregateKind: "project" },
        { sequence: 19, applicationEventVersion: 1, aggregateKind: "thread" },
      ],
      projectionLastSequence: 12,
    });
    expect(evidence).toEqual({
      latestV2ThreadSequence: 12,
      latestApplicationVersion2Sequence: 14,
      latestNativeApplicationSequence: 17,
      globalMaximumSequence: 19,
      projectionCurrent: true,
    });
  });

  it.skipIf(!t3SourceDir)("hydrates and compacts a real copied v1 database, then recovers without writes", async () => {
    const tempRoot = join(process.cwd(), "node_modules/.cache");
    mkdirSync(tempRoot, { recursive: true });
    const root = await mkdtemp(join(tempRoot, "t3-v2-upgrade-reconcile-"));
    const built = execFileSync(process.execPath, [legacyFixtureRunner, root], {
      env: { ...process.env, T3_V2_T3_SOURCE_DIR: t3SourceDir!, ...(t3DependencyRoot ? { T3_V2_T3_DEPENDENCY_ROOT: t3DependencyRoot } : {}) }, encoding: "utf8",
    }).trim().split("\n").at(-1)!;
    const fixture = JSON.parse(built) as { dbPath: string; threadId: string; compacted: { deletedEventCount: number } };
    const dbPath = fixture.dbPath;
    expect(fixture.compacted.deletedEventCount).toBeGreaterThan(0);
    const db = new Database(dbPath);
    const fixtureThreadId = fixture.threadId;
    try {
      const latest = db.prepare("SELECT * FROM orchestration_events WHERE application_event_version = 2 ORDER BY sequence DESC LIMIT 1").get() as Record<string, unknown> | undefined;
      if (!latest) throw new Error("Pinned v2 fixture has no native v2 event for the retained-v1 sequence case.");
      const globalMaximum = Number((db.prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM orchestration_events").get() as { value: number }).value);
      db.prepare(`INSERT INTO orchestration_events (
        sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json,
        application_event_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
        globalMaximum + 100, "synthetic-retained-v1-event", "thread", "retained-v1-tail-thread",
        1, "thread.updated", latest.occurred_at, latest.command_id,
        latest.causation_event_id, latest.correlation_id, latest.actor_kind, latest.payload_json,
        latest.metadata_json,
      );
      // The fixture now represents a compacted conversion: visible projections remain,
      // while the synthetic retained v1 tail is not part of the v2 projection cursor.
      db.prepare("DELETE FROM orchestration_events WHERE application_event_version = 1 AND event_id <> 'synthetic-retained-v1-event'").run();
    } finally {
      db.close();
    }

    const inspected = JSON.parse(execFileSync(process.execPath, [nativeHelper], {
      input: JSON.stringify({ op: "inspect", dbPath, threadIds: [fixtureThreadId] }),
      encoding: "utf8",
    })) as {
      projectionMetadata: Array<{ projectionName: string; lastSequence: number }>;
      threads: Array<{ threadId: string; exists: boolean; thread?: { id: string; projectId: string; historyOrigin: string; activeProviderThreadId: string | null }; records?: { messages: Array<{ role: string; text: string }>; turnItems: Array<Record<string, unknown>>; plans: Array<Record<string, unknown>>; providerThreads?: Array<Record<string, unknown>>; providerTurns?: Array<Record<string, unknown>> }; events: Array<{ sequence: number }> }>;
    };
    const dbRead = new Database(dbPath, { readonly: true });
    let evidence: ReturnType<typeof v2UpgradeSequenceEvidence>;
    try {
      const rows = dbRead.prepare("SELECT sequence, application_event_version AS applicationEventVersion, aggregate_kind AS aggregateKind FROM orchestration_events").all() as Array<{ sequence: number; applicationEventVersion: number; aggregateKind: string }>;
      const metadata = inspected.projectionMetadata.find((row) => row.projectionName === "thread-projections");
      if (!metadata) throw new Error("Pinned v2 projection metadata is missing.");
      evidence = v2UpgradeSequenceEvidence({ events: rows, projectionLastSequence: metadata.lastSequence });
    } finally {
      dbRead.close();
    }
    const nativeThread = inspected.threads[0];
    expect(nativeThread).toMatchObject({ threadId: fixtureThreadId, exists: true, thread: { historyOrigin: "v1_import" } });
    const eventCountBeforeRecovery = evidence.globalMaximumSequence;
    const sourceThread = canonicalThread("/tmp/t3-upgrade-fixture");
    sourceThread.sourceSessionId = fixtureThreadId;
    sourceThread.sourceKey = `codex:${fixtureThreadId}`;
    sourceThread.model = "gpt-5.4";
    sourceThread.resumeCursor = { threadId: fixtureThreadId };
    sourceThread.turns[0]!.user.text = "Question";
    sourceThread.turns[0]!.user.sourceId = "legacy-message-06-user";
    sourceThread.turns[0]!.user.timestamp = "2026-01-01T00:00:00.000Z";
    sourceThread.turns[0]!.assistant = [{ sourceId: "legacy-message-06-assistant", role: "assistant", text: "Answer", timestamp: "2026-01-01T00:00:01.000Z", attachments: [] }];
    sourceThread.turns[0]!.activities = [];
    sourceThread.turns[0]!.plans = [];
    const expectedEvents = encodeCanonicalHistory(sourceThread, fixtureThreadId, join(root, "attachments")).events;
    const fullHistoryMatches = projectedHistoryMatches(nativeThread!.records, expectedEvents, { identity: "semantic" });
    const recovered = reconcileUpgradedImport({
      source: { provider: "codex", sourceSessionId: fixtureThreadId, sourceKey: `codex:${fixtureThreadId}`,
        expectedThreadId: fixtureThreadId, projectId: "project-06" },
      candidates: [{
        threadId: nativeThread!.threadId, projectId: nativeThread!.thread!.projectId,
        historyOrigin: nativeThread!.thread!.historyOrigin,
        historyVerification: fullHistoryMatches ? "exact" : "diverged",
      }],
    });
      expect(nativeThread!.records?.providerThreads).toEqual([]);
      expect(nativeThread!.records?.providerTurns).toEqual([]);
      expect(nativeThread!.thread?.activeProviderThreadId).toBeNull();
      expect(recovered).toMatchObject({ status: "needs-binding", threadId: fixtureThreadId, recoveredLedger: true, action: expect.any(String) });
    expect(evidence.globalMaximumSequence).toBeGreaterThan(evidence.latestApplicationVersion2Sequence);
    expect(evidence.globalMaximumSequence).toBeGreaterThan(evidence.latestNativeApplicationSequence);
    expect(evidence.projectionCurrent).toBe(true);
    expect(evidence.latestV2ThreadSequence).toBe(nativeThread!.events.at(-1)!.sequence);
    expect(inspected.projectionMetadata.find((row) => row.projectionName === "thread-projections")!.lastSequence).toBe(evidence.latestV2ThreadSequence);
    expect(evidence.globalMaximumSequence).toBe(eventCountBeforeRecovery);
  });
});
