import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceLock = JSON.parse(await readFile(join(root, "scripts/compatibility/v2-native/source-lock.json"), "utf8"));
const sourceRoot = join(root, "artifacts/t3-reference-2994", `t3code-${sourceLock.t3SourceCommit}`);
const lockMarker = process.env.T3_V2_PINNED_LOCK_HELD ?? "";
const lockedRun = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lockMarker);

if (!lockedRun) {
  if (process.platform !== "linux") throw new Error("Pinned-v2 preparation is Linux-only because the pinned build tools and shared lock use flock.");
  const lockRoot = join(root, "artifacts/v2-native");
  await mkdir(lockRoot, { recursive: true });
  const lockPath = join(lockRoot, ".pinned-v2.lock");
  console.log(`Waiting for pinned-v2 preparation lock: ${lockPath}`);
  const locked = spawnSync("flock", ["--exclusive", "--timeout", "2700", lockPath, process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: root,
    env: { ...process.env, T3_V2_PINNED_LOCK_HELD: randomUUID() },
    stdio: "inherit",
  });
  if (locked.error) throw locked.error;
  process.exit(locked.status ?? 1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
}

function assertPinnedInputs(fixtureDb) {
  for (const [name, path] of Object.entries({
    T3_V2_FIXTURE_DB: fixtureDb,
    T3_V2_T3_SOURCE_DIR: sourceRoot,
    T3_V2_T3_DEPENDENCY_ROOT: sourceRoot,
  })) {
    if (!path || !existsSync(path)) throw new Error(`Required pinned-v2 input ${name} is missing: ${path ?? "<unset>"}`);
  }
}

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--artifact-dir" || !args[1])) {
  throw new Error("Usage: pinned-test.mjs [--artifact-dir <output-directory>]");
}
const artifactDir = args.length === 2 ? resolve(args[1]) : undefined;
const temporaryRoot = artifactDir ?? await mkdtemp(join(tmpdir(), "t3-import-v2-pinned-"));
const preserveArtifacts = artifactDir !== undefined;
if (preserveArtifacts) {
  await mkdir(temporaryRoot, { recursive: true });
  for (const output of ["fixture/statev2.sqlite", "pinned-test-manifest.json", "pinned-test-report.json"]) {
    if (existsSync(join(temporaryRoot, output))) throw new Error(`Pinned-v2 output already exists; refusing to overwrite it: ${join(temporaryRoot, output)}`);
  }
}
try {
  run(process.execPath, ["scripts/compatibility/v2-proof/prepare.mjs"]);
  run("npm", ["run", "build"]);
  const reviewedManifest = join(root, "scripts/compatibility/v2-native/vendor-manifest.json");
  const reviewedNotices = join(root, "scripts/compatibility/v2-native/LICENSES.md");
  const reviewedHashes = await Promise.all([reviewedManifest, reviewedNotices].map(async (path) =>
    createHash("sha256").update(await readFile(path)).digest("hex")));
  run(process.execPath, ["scripts/compatibility/v2-native/build.mjs"]);
  const candidateBuildHashes = await Promise.all([reviewedManifest, reviewedNotices].map(async (path) =>
    createHash("sha256").update(await readFile(path)).digest("hex")));
  if (candidateBuildHashes.some((hash, index) => hash !== reviewedHashes[index])) {
    throw new Error("Pinned candidate build modified reviewed vendor manifest or license notices.");
  }

  const fixtureDb = join(temporaryRoot, "fixture/statev2.sqlite");
  run(process.execPath, ["artifacts/v2-native/fixture.mjs", fixtureDb]);
  assertPinnedInputs(fixtureDb);
  const fixtureHash = createHash("sha256").update(await readFile(fixtureDb)).digest("hex");

  const v2Tests = ["test/schema.test.ts", ...(await readdir(join(root, "test")))
    .filter((name) => /^v2-.*\.test\.ts$/.test(name))
    .sort()
    .map((name) => `test/${name}`)];
  const testEnv = {
    ...process.env,
    T3_V2_FIXTURE_DB: fixtureDb,
    T3_V2_T3_SOURCE_DIR: sourceRoot,
    T3_V2_T3_DEPENDENCY_ROOT: sourceRoot,
    T3_V2_SOURCE_COMMIT: sourceLock.t3SourceCommit,
    T3_V2_REQUIRED: "1",
  };
  assertPinnedInputs(fixtureDb);
  const jsonReport = join(temporaryRoot, preserveArtifacts ? "pinned-test-report.json" : "vitest-report.json");
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--testTimeout=20000", "--reporter=default", "--reporter=json", `--outputFile=${jsonReport}`, ...v2Tests], { env: testEnv });
  const report = JSON.parse(await readFile(jsonReport, "utf8"));
  if (report.numPendingTests !== 0 || report.numTodoTests !== 0) {
    throw new Error(`Required pinned-v2 suites must not skip tests (pending=${report.numPendingTests}, todo=${report.numTodoTests}).`);
  }
  run("npm", ["run", "test:v2-pack"]);
  const finalFixtureHash = createHash("sha256").update(await readFile(fixtureDb)).digest("hex");
  if (finalFixtureHash !== fixtureHash) throw new Error("Pinned-v2 tests modified the shared source fixture database.");
  if (preserveArtifacts) {
    const manifestPath = join(temporaryRoot, "pinned-test-manifest.json");
    const helperPath = join(root, "vendor/t3-v2-native-helper.mjs");
    const helperHash = createHash("sha256").update(await readFile(helperPath)).digest("hex");
    const manifest = {
      schemaVersion: 1,
      sourceCommit: sourceLock.t3SourceCommit,
      fixturePath: relative(temporaryRoot, fixtureDb),
      fixtureSha256: fixtureHash,
      helperSha256: helperHash,
      nativeFixture: "fresh native schema created by migrations from the pinned T3 source",
      migrationRevision: 61,
      testReport: relative(temporaryRoot, jsonReport),
      tests: {
        passed: report.numPassedTests,
        total: report.numTotalTests,
        pending: report.numPendingTests,
        todo: report.numTodoTests,
        suitesPassed: report.numPassedTestSuites,
        suitesTotal: report.numTotalTestSuites,
      },
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    console.log(`PINNED_V2_FIXTURE_MANIFEST=${relative(root, manifestPath)}`);
  }
} finally {
  if (!preserveArtifacts) await rm(temporaryRoot, { recursive: true, force: true });
}
