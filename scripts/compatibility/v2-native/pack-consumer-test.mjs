import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureRunner = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!fixtureRunner) throw new Error("usage: node pack-consumer-test.mjs <pinned-fixture-runner.mjs>");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr ?? ""}${result.stdout ?? ""}`);
  return result;
}

const temp = await mkdtemp(join(tmpdir(), "t3-import-v2-packed-consumer-"));
const packDir = join(temp, "pack");
const consumer = join(temp, "consumer");
const home = join(temp, "home");
const codexHome = join(temp, "codex");
const claudeHome = join(temp, "claude");
const configHome = join(temp, "config");
const workspace = join(temp, "workspace");
const dbPath = join(temp, "userdata", "statev2.sqlite");
await Promise.all([packDir, consumer, home, codexHome, claudeHome, configHome, workspace, dirname(dbPath)].map((path) => mkdir(path, { recursive: true })));
run(process.execPath, [fixtureRunner, dbPath], { cwd: temp, env: { ...process.env, NODE_PATH: "" } });

const packOutput = run("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: root }).stdout;
const packJsonStart = packOutput.search(/[\[{]/u);
if (packJsonStart < 0) throw new Error(`npm pack did not return JSON metadata:\n${packOutput}`);
const packMetadata = JSON.parse(packOutput.slice(packJsonStart));
const packed = Array.isArray(packMetadata) ? packMetadata[0] : Object.values(packMetadata)[0];
const tarball = join(packDir, packed.filename);
run("npm", ["init", "-y"], { cwd: consumer, stdio: "ignore" });
run("npm", ["install", tarball], { cwd: consumer });
run("npm", ["install-scripts", "approve", "better-sqlite3"], { cwd: consumer });
run("npm", ["rebuild", "better-sqlite3"], { cwd: consumer });

const sessionId = "11111111-2222-4333-8444-555555555555";
const sessionDir = join(codexHome, "sessions", "2026", "10", "11");
await mkdir(sessionDir, { recursive: true });
const sessionPath = join(sessionDir, `${sessionId}.jsonl`);
const rows = [
  { timestamp: "2026-10-11T00:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: workspace } },
  { timestamp: "2026-10-11T00:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
  { timestamp: "2026-10-11T00:00:01Z", type: "response_item", payload: { type: "message", role: "user", id: "user-1", content: [{ type: "input_text", text: "Hello from packed consumer" }] } },
  { timestamp: "2026-10-11T00:00:02Z", type: "response_item", payload: { type: "message", role: "assistant", id: "assistant-1", content: [{ type: "output_text", text: "Hi from packed consumer" }] } },
  { timestamp: "2026-10-11T00:00:03Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
];
await writeFile(sessionPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

const environment = {
  ...process.env,
  HOME: home,
  CODEX_HOME: codexHome,
  CODEX_BIN: join(temp, "missing-codex"),
  CLAUDE_CONFIG_DIR: claudeHome,
  XDG_CONFIG_HOME: configHome,
  NODE_PATH: "",
  PATH: "/usr/bin:/bin",
};
const cli = join(consumer, "node_modules/@carlosgtrz/t3-import/dist/cli.js");
const importArgs = [cli, "--db", dbPath, "--json", "import", "--source", "codex", "--workspace", workspace, "--thread", sessionId, "--yes"];
const first = JSON.parse(run(process.execPath, importArgs, { cwd: consumer, env: environment }).stdout);
assert.equal(first.status, "imported");
assert.equal(first.results[0]?.messages, 2);
assert.ok(first.backup);

const helper = join(consumer, "node_modules/@carlosgtrz/t3-import/vendor/t3-v2-native-helper.mjs");
const inspect = () => JSON.parse(execFileSync(process.execPath, [helper], {
  cwd: consumer,
  env: environment,
  input: JSON.stringify({ op: "inspect", dbPath, threadIds: [sessionId], projectIds: [first.results[0].projectId] }),
  encoding: "utf8",
}));
const afterWrite = inspect();
const imported = afterWrite.threads[0];
assert.equal(imported?.exists, true);
assert.equal(imported?.thread.historyOrigin, "v1_import");
assert.deepEqual(imported?.records.messages.map(({ role, text }) => ({ role, text })), [
  { role: "user", text: "Hello from packed consumer" },
  { role: "assistant", text: "Hi from packed consumer" },
]);
assert.ok(imported?.records.providerThreads.some((entry) => entry.nativeThreadRef?.nativeId === sessionId && entry.nativeThreadRef?.strength === "strong"));

const beforeRetry = afterWrite.projectionMetadata[0]?.lastSequence;
const retry = JSON.parse(run(process.execPath, importArgs, { cwd: consumer, env: environment }).stdout);
assert.equal(retry.status, "already-imported");
assert.equal(inspect().projectionMetadata[0]?.lastSequence, beforeRetry);

rows[3].payload.content[0].text = "Changed history";
await writeFile(sessionPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
const conflict = JSON.parse(run(process.execPath, importArgs, { cwd: consumer, env: environment }).stdout);
assert.equal(conflict.status, "mixed");
assert.equal(conflict.results?.[0]?.status, "conflict");
assert.match(conflict.results?.[0]?.warnings?.join("\n") ?? "", /source no longer matches its saved pre-upgrade checkpoint/u);
assert.equal(inspect().projectionMetadata[0]?.lastSequence, beforeRetry);

console.log(JSON.stringify({ result: "PASS", package: packed.name, version: packed.version, helperBytes: afterWrite ? (await (await import("node:fs/promises")).stat(helper)).size : 0,
  import: first.status, retry: retry.status, divergentHistoryRejected: true, structuredConflict: true, nativeReadback: true, temp }));
