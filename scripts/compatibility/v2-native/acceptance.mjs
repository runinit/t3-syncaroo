import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "../../..");
const defaultBase = join(root, "artifacts/v2-native/acceptance");

export async function createFreshOutput(path) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  try {
    await mkdir(absolute);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Acceptance output already exists; refusing to reuse or clear it: ${absolute}`);
    throw error;
  }
  return absolute;
}

export function makeIsolatedEnvironment(runRoot, source = process.env) {
  const inherited = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "TZ"]) {
    if (typeof source[name] === "string") inherited[name] = source[name];
  }
  const isolated = {
    ...inherited,
    CI: "true",
    HOME: join(runRoot, "home"),
    XDG_CONFIG_HOME: join(runRoot, "config"),
    XDG_CACHE_HOME: join(runRoot, "cache"),
    XDG_DATA_HOME: join(runRoot, "data"),
    CODEX_HOME: join(runRoot, "providers/codex"),
    CLAUDE_CONFIG_DIR: join(runRoot, "providers/claude"),
    CODEX_BIN: join(runRoot, "absent-provider-binaries/codex"),
    T3_HOME: join(runRoot, "t3-home"),
    T3CODE_HOME: join(runRoot, "t3-home"),
    T3_IMPORT_DATA_DIR: join(runRoot, "ledger"),
    TMPDIR: join(runRoot, "tmp"),
  };
  return isolated;
}

const targetQueues = new Map();
export function serializeByTarget(target, operation) {
  const previous = targetQueues.get(target) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  targetQueues.set(target, current);
  return current.finally(() => {
    if (targetQueues.get(target) === current) targetQueues.delete(target);
  });
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--output-dir", "--appimage", "--manifest", "--codex-screenshot", "--claude-screenshot"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      const key = { "--output-dir": "outputDir", "--appimage": "appImage", "--manifest": "manifestPath",
        "--codex-screenshot": "codexScreenshot", "--claude-screenshot": "claudeScreenshot" }[arg];
      options[key] = value;
    } else if (arg === "--complete-gui") options.completeGui = true;
    else if (arg === "--workspace-stopped") options.workspaceStopped = true;
    else if (arg === "--apps-closed") options.appsClosed = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function relativeArtifact(path) { return relative(root, path).split(sep).join("/"); }

async function verifyPinnedTarget(appImage) {
  const sourceLock = JSON.parse(await readFile(join(scriptDir, "source-lock.json"), "utf8"));
  const evidence = JSON.parse(await readFile(join(root, "docs/t3-v2-builtin-import-evidence.json"), "utf8"));
  const archivePath = join(root, sourceLock.sourceArchive.path);
  const archiveSha256 = sha256(await readFile(archivePath));
  if (archiveSha256 !== sourceLock.sourceArchive.sha256) {
    throw new Error(`Pinned T3 source archive checksum mismatch (expected ${sourceLock.sourceArchive.sha256}, got ${archiveSha256}).`);
  }
  if (evidence.target.commit !== sourceLock.t3SourceCommit) {
    throw new Error("Pinned T3 evidence commit does not match source-lock.json.");
  }
  let appImageSha256 = null;
  if (appImage) {
    appImageSha256 = sha256(await readFile(resolve(appImage)));
    if (appImageSha256 !== evidence.target.appImageSha256) {
      throw new Error(`T3 AppImage checksum mismatch (expected ${evidence.target.appImageSha256}, got ${appImageSha256}).`);
    }
  }
  return {
    version: evidence.target.version,
    sourceCommit: sourceLock.t3SourceCommit,
    sourceArchiveSha256: archiveSha256,
    expectedAppImageSha256: evidence.target.appImageSha256,
    appImageSha256,
  };
}

async function ensureIsolatedHomes(runRoot) {
  const env = makeIsolatedEnvironment(runRoot);
  await Promise.all([
    env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.CODEX_HOME,
    env.CLAUDE_CONFIG_DIR, env.T3_HOME, env.T3_IMPORT_DATA_DIR, env.TMPDIR,
  ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(join(env.T3_HOME, ".synthetic-t3-home"), "t3-import v2 acceptance fixture\n", { mode: 0o600 });
  return env;
}

function runNode(script, args, options) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: options.env,
    timeout: options.timeout ?? 20 * 60_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function assertSuccessful(name, result, logPath) {
  if (result.status !== 0) throw new Error(`${name} failed with exit code ${result.status}; see ${relativeArtifact(logPath)}`);
}

function sanitizeMessage(error, appImage) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replaceAll(root, "[checkout]").replaceAll(resolve(homedir()), "[user-home]");
  if (appImage) message = message.replaceAll(resolve(appImage), "[AppImage]");
  return message;
}

async function saveLog(path, result, runRoot) {
  let contents = `${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`;
  contents = contents
    .replaceAll(runRoot, "[acceptance-run]")
    .replaceAll(root, "[checkout]")
    .replaceAll(resolve(homedir()), "[user-home]")
    .replace(/\b(?:sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/gu, "[REDACTED_TOKEN]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED_TOKEN]");
  await writeFile(path, contents, { mode: 0o600 });
}

function defaultOutputPath() {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return join(defaultBase, timestamp);
}

function help() {
  return [
    "Usage: npm run acceptance:v2 -- [--output-dir NEW_EMPTY_PATH] [--appimage PATH]",
    "Runs the mandatory pinned v2 tests and prepares synthetic Codex/Claude desktop fixtures.",
    "The output directory must not already exist. Artifacts are retained under artifacts/v2-native/acceptance/.",
    "The runner never launches T3, provider apps, or an Agent Workspace; follow GUI_CHECKLIST.md in an isolated workspace.",
    "After GUI checks, record evidence with --complete-gui --manifest <run>/manifest.json --codex-screenshot <run-relative-path> --claude-screenshot <run-relative-path> --workspace-stopped --apps-closed.",
  ].join("\n");
}

async function completeGui(options) {
  if (!options.manifestPath || !options.codexScreenshot || !options.claudeScreenshot
    || !options.workspaceStopped || !options.appsClosed) {
    throw new Error("GUI completion requires --manifest, both screenshot paths, --workspace-stopped, and --apps-closed.");
  }
  const manifestPath = resolve(options.manifestPath);
  const output = dirname(manifestPath);
  const outputRelative = relative(defaultBase, output);
  if (outputRelative === ".." || outputRelative.startsWith(`..${sep}`) || !outputRelative) {
    throw new Error(`GUI manifest must be inside ${relativeArtifact(defaultBase)}.`);
  }
  const value = JSON.parse(await readFile(manifestPath, "utf8"));
  if (value.schemaVersion !== 1 || value.status !== "prepared" || value.gui?.status !== "pending") {
    throw new Error("GUI completion requires a prepared run with pending GUI evidence.");
  }
  if (!value.target?.appImageSha256 || value.target.appImageSha256 !== value.target.expectedAppImageSha256) {
    throw new Error("GUI completion requires the pinned AppImage checksum to have been verified by the runner.");
  }
  const afterViewPath = join(output, "gui/after-view-results.json");
  const afterView = JSON.parse(await readFile(afterViewPath, "utf8"));
  if (afterView.status !== "passed" || !afterView.providers?.codex || !afterView.providers?.claude) {
    throw new Error("Post-view replacement and repeat-sync results are missing or incomplete.");
  }
  const screenshots = [];
  for (const [provider, rawPath] of [["codex", options.codexScreenshot], ["claude", options.claudeScreenshot]]) {
    if (isAbsolute(rawPath) || rawPath.includes("\\")) throw new Error(`${provider} screenshot path must be run-relative.`);
    const imagePath = resolve(output, rawPath);
    const imageRelative = relative(output, imagePath);
    if (!imageRelative.startsWith(`screenshots${sep}`)) throw new Error(`${provider} screenshot must be stored under the run screenshots directory.`);
    const details = await stat(imagePath);
    if (!details.isFile() || details.size === 0) throw new Error(`${provider} screenshot file is empty or missing.`);
    screenshots.push(imageRelative.split(sep).join("/"));
  }
  value.gui.status = "passed";
  value.gui.screenshots = screenshots;
  value.gui.afterViewResults = relative(output, afterViewPath).split(sep).join("/");
  value.gui.workspaceCleanup = { agentWorkspace: "stopped", apps: "closed", confirmedAt: new Date().toISOString() };
  value.status = "accepted";
  const temporary = `${manifestPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, manifestPath);
  console.log(JSON.stringify({ status: value.status, manifest: relativeArtifact(manifestPath), screenshots }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(help()); return; }
  if (options.completeGui) { await completeGui(options); return; }
  const requestedOutput = resolve(options.outputDir ?? defaultOutputPath());
  const outputRelative = relative(defaultBase, requestedOutput);
  if (outputRelative === "" || outputRelative === ".." || outputRelative.startsWith(`..${sep}`) || resolve(requestedOutput) === root) {
    throw new Error(`Acceptance output must be a new directory under ${relativeArtifact(defaultBase)}.`);
  }
  const output = await createFreshOutput(requestedOutput);
  const logsDir = join(output, "logs");
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const checks = [];
  let failureOutput = null;
  const manifestPath = join(output, "manifest.json");
  let pin = null;
  let fixture = null;
  let fixtureDatabasePath = null;
  let failure = null;
  const relativeOutput = relativeArtifact(output);
  const manifest = () => {
    const fixtureHomes = fixture?.isolation
      ? ["home", "xdgConfig", "xdgData", "codexHome", "claudeHome", "t3Home", "ledger"].map((key) => relativeArtifact(fixture.isolation[key]))
      : [];
    return ({
    schemaVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    status: failure ? "failed" : checks.every((check) => check.status === "passed") ? "prepared" : "incomplete",
    target: pin,
    isolation: {
      root: relativeOutput,
      homes: ["home", "config", "cache", "data", "providers/codex", "providers/claude", "t3-home", "ledger"].map((path) => `${relativeOutput}/${path}`).concat(fixtureHomes),
      nativeFixtureDatabase: fixtureDatabasePath ? relativeArtifact(fixtureDatabasePath) : null,
      normalHomesTouched: false,
      workspaceLaunched: false,
    },
    checks,
    gui: {
      status: "pending",
      fixtureManifest: fixture ? `${relativeOutput}/gui/fixture-manifest.json` : null,
      checklist: `${relativeOutput}/GUI_CHECKLIST.md`,
      screenshotDirectory: `${relativeOutput}/screenshots`,
      workspaceCleanup: "not-launched-by-runner",
    },
    error: failure,
    });
  };
  const writeManifest = async () => writeFile(manifestPath, `${JSON.stringify(manifest(), null, 2)}\n`, { mode: 0o600 });
  try {
    pin = await verifyPinnedTarget(options.appImage);
    checks.push({ name: "pinned-target", command: "verify source-lock.json, pinned evidence, and optional --appimage SHA-256", status: "passed",
      summary: "T3 source archive and commit match the checked-in pin; AppImage checksum verified when supplied.", output: null });
    const env = await ensureIsolatedHomes(output);
    const safetyLog = join(logsDir, "runner-safety.log");
    failureOutput = relativeArtifact(safetyLog);
    const safety = runNode(join(scriptDir, "acceptance-runner.test.mjs"), [], { env, timeout: 60_000 });
    await saveLog(safetyLog, safety, output);
    assertSuccessful("Acceptance runner safety checks", safety, safetyLog);
    checks.push({ name: "runner-safety", status: "passed", command: "node scripts/compatibility/v2-native/acceptance-runner.test.mjs",
      summary: "Fresh-output refusal, environment isolation, and per-target operation serialization checks passed.", output: relativeArtifact(safetyLog) });

    const pinnedLog = join(logsDir, "pinned-test.log");
    failureOutput = relativeArtifact(pinnedLog);
    const pinnedPath = join(scriptDir, "pinned-test.mjs");
    const pinnedDir = join(output, "pinned");
    const pinned = runNode(pinnedPath, ["--artifact-dir", pinnedDir], { env, timeout: 45 * 60_000 });
    await saveLog(pinnedLog, pinned, output);
    assertSuccessful("Pinned v2 test suite", pinned, pinnedLog);
    const pinnedManifestPath = join(pinnedDir, "pinned-test-manifest.json");
    const pinnedManifest = JSON.parse(await readFile(pinnedManifestPath, "utf8"));
    const fixtureDatabase = isAbsolute(pinnedManifest.fixturePath)
      ? resolve(pinnedManifest.fixturePath)
      : resolve(pinnedDir, pinnedManifest.fixturePath);
    const pinnedDirPrefix = `${resolve(pinnedDir)}${sep}`;
    if (!fixtureDatabase.startsWith(pinnedDirPrefix)) throw new Error("Pinned test fixture path is outside the acceptance run directory.");
    if (sha256(await readFile(fixtureDatabase)) !== pinnedManifest.fixtureSha256) throw new Error("Pinned native fixture database checksum does not match its manifest.");
    fixtureDatabasePath = fixtureDatabase;
    pinnedManifest.fixturePath = relative(pinnedDir, fixtureDatabase).split(sep).join("/");
    pinnedManifest.testReport = "pinned-test-report.json";
    await writeFile(pinnedManifestPath, `${JSON.stringify(pinnedManifest, null, 2)}\n`, { mode: 0o600 });
    checks.push({ name: "pinned-v2-suite", status: "passed", command: "node scripts/compatibility/v2-native/pinned-test.mjs",
      summary: `Required v2 tests and packed consumer completed (${pinnedManifest.tests.passed}/${pinnedManifest.tests.total} tests).`,
      output: relativeArtifact(join(pinnedDir, "pinned-test-report.json")) });

    const cliPath = join(root, "dist/cli.js");
    const cliSha256 = sha256(await readFile(cliPath));
    checks.push({ name: "package-cli-build", status: "passed", command: "npm run test:v2-pack (npm pack prepack)",
      summary: `The packed-consumer check ran package prepack; dist/cli.js is present (${cliSha256.slice(0, 12)}…).`, output: relativeArtifact(pinnedLog) });

    const guiDir = join(output, "gui");
    const fixtureLog = join(logsDir, "gui-fixture.log");
    failureOutput = relativeArtifact(fixtureLog);
    const fixtureRunner = join(scriptDir, "gui-fixture.mjs");
    const args = ["--output-dir", guiDir, "--fixture-db", fixtureDatabase];
    if (options.appImage) args.push("--appimage", resolve(options.appImage));
    const prepared = runNode(fixtureRunner, args, { env, timeout: 10 * 60_000 });
    await saveLog(fixtureLog, prepared, output);
    assertSuccessful("Synthetic GUI fixture preparation", prepared, fixtureLog);
    fixture = JSON.parse(prepared.stdout.trim().split(/\r?\n/u).at(-1));
    checks.push({ name: "gui-fixture-preparation", status: "passed", command: "node scripts/compatibility/v2-native/gui-fixture.mjs",
      summary: "Synthetic Codex and Claude tasks imported; serial sync and replacement previews prepared.", output: relativeArtifact(fixtureLog) });
    const screenshotDir = join(output, "screenshots");
    await mkdir(screenshotDir, { mode: 0o700 });
    const checklist = [
      `# T3 v2 GUI acceptance (${pin.version})`,
      "",
      `Use only the Agent Workspace desktop. The pinned AppImage SHA-256 is \`${pin.expectedAppImageSha256}\`. If this run's manifest has \`target.appImageSha256: null\`, verify the AppImage separately before launching. Use only the isolated fixture T3 home from gui/fixture-manifest.json.`,
      "",
      "1. Confirm the two synthetic Codex and Claude tasks appear and open each task.",
      "2. Check the user and assistant messages, image attachment, plan, and completed shell command are visible.",
      `3. Save provider-labeled screenshots without account/auth UI as \`${relativeOutput}/screenshots/codex.png\` and \`${relativeOutput}/screenshots/claude.png\`.`,
      `4. From the checkout root, after viewing both original tasks, run: \`node scripts/compatibility/v2-native/gui-fixture.mjs --after-view-manifest ${relativeOutput}/gui/fixture-manifest.json\`. This replaces the viewed tasks and serially runs sync twice for each provider.`,
      `5. Confirm \`${relativeOutput}/gui/after-view-results.json\` reports both replacements and stable zero-change syncs.`,
      `6. Close T3 and all launched apps, stop the Agent Workspace, then run: \`npm run acceptance:v2:complete-gui -- --manifest ${relativeOutput}/manifest.json --codex-screenshot screenshots/codex.png --claude-screenshot screenshots/claude.png --workspace-stopped --apps-closed\`.`,
      "",
      "This runner prepares synthetic fixtures only. A `prepared` status does not mean GUI acceptance passed.",
      "",
    ].join("\n");
    await writeFile(join(output, "GUI_CHECKLIST.md"), checklist, { mode: 0o600 });
  } catch (error) {
    failure = sanitizeMessage(error, options.appImage);
    checks.push({ name: "acceptance-run", command: "npm run acceptance:v2", status: "failed", summary: failure, output: failureOutput });
  } finally {
    await writeManifest();
  }
  console.log(JSON.stringify({ status: manifest().status, manifest: relativeArtifact(manifestPath), guiChecklist: `${relativeOutput}/GUI_CHECKLIST.md` }));
  if (failure) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
