import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalConversation, canonicalThread } from "./helpers.js";
import { resolveTargetPaths } from "../src/target/config.js";
import { importConversations } from "../src/target/importer.js";

const fixture = process.env.T3_V2_FIXTURE_DB;
const helper = fileURLToPath(new URL("../vendor/t3-v2-native-helper.mjs", import.meta.url));

describe.skipIf(!fixture || !existsSync(fixture))("pinned T3 nightly v2 Claude import", () => {
  it("preserves a selected alternate branch's Claude session and assistant head references", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-v2-claude-"));
    const workspace = join(root, "workspace");
    const dbPath = join(root, "userdata", "statev2.sqlite");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(root, "userdata"), { recursive: true });
    copyFileSync(fixture!, dbPath);
    const paths = resolveTargetPaths({ dbPath });
    const thread = canonicalThread(workspace);
    thread.source = "claude";
    thread.sourceSessionId = "22222222-2222-4222-8222-222222222222";
    thread.sourceKey = `claude:${thread.sourceSessionId}:alternate-leaf`;
    thread.leafId = "alternate-user-endpoint";
    thread.currentBranch = false;
    thread.title = "Selected alternate Claude branch";
    thread.model = "claude-test";
    thread.turns[0]!.activities = [];
    thread.resumeCursor = {
      resume: thread.sourceSessionId,
      resumeSessionAt: "last-assistant-node",
      turnCount: 1,
    };
    const conversation = canonicalConversation(workspace, thread);
    conversation.summary.source = "claude";
    conversation.summary.id = thread.sourceSessionId;
    conversation.summary.branches = 2;

    const result = await importConversations([{ conversation, resume: true }], paths, {
      dryRun: false,
      resume: true,
    });
    expect(result.status).toBe("imported");
    expect(result.results[0]).toMatchObject({ source: "claude", resumable: true });

    const inspected = JSON.parse(execFileSync(process.execPath, [helper], {
      input: JSON.stringify({ op: "inspect", dbPath, threadIds: [result.results[0]!.threadId] }),
      encoding: "utf8",
    })) as {
      threads: Array<{
        records: {
          providerThreads: Array<{
            driver: string;
            nativeThreadRef: { driver: string; nativeId: string; strength: string };
            nativeConversationHeadRef: { driver: string; nativeId: string; strength: string } | null;
          }>;
        };
      }>;
    };
    expect(inspected.threads[0]!.records.providerThreads).toContainEqual(expect.objectContaining({
      driver: "claudeAgent",
      nativeThreadRef: { driver: "claudeAgent", nativeId: thread.sourceSessionId, strength: "strong" },
      nativeConversationHeadRef: { driver: "claudeAgent", nativeId: "last-assistant-node", strength: "strong" },
    }));
  });
});
