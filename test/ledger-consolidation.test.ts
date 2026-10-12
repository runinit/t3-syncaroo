import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { listImports, recordConsolidation, type LedgerRecord } from "../src/target/ledger.js";

const originalLedgerDir = process.env.T3_IMPORT_DATA_DIR;
afterEach(() => {
  if (originalLedgerDir === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedgerDir;
});

describe("ledger consolidation", () => {
  it("persists the verified Claude conversation head on the canonical replacement row", async () => {
    process.env.T3_IMPORT_DATA_DIR = await mkdtemp(join(tmpdir(), "t3-ledger-consolidation-head-"));
    const replacement: LedgerRecord = {
      targetId: "current-target", source: "claude", sourceSessionId: "claude-session",
      sourceKey: "claude:claude-session:assistant-new", sourceFingerprint: "new-fingerprint",
      projectId: "project", threadId: "replacement-thread", importedAt: "2026-01-01T00:00:00.000Z",
      importerVersion: "0.4.1", migration: 61, firstSequence: 20, lastSequence: 30,
      resumable: true, backupPath: "backup.sqlite", warnings: [],
      identitySeed: "claude:claude-session:assistant-old", currentSourceKey: "claude:claude-session:assistant-new",
      sourceLeafId: "assistant-new", nativeConversationHeadId: "assistant-current", sourceTitle: "Replacement",
      checkpoint: { version: 2, turns: [] }, syncedAt: "2026-01-01T00:00:00.000Z", isCanonical: true,
    };

    recordConsolidation([], replacement);

    expect(listImports("current-target", "claude")[0]).toMatchObject({
      threadId: "replacement-thread", nativeConversationHeadId: "assistant-current",
    });
  });
});
