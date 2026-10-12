#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serializeByTarget } from './acceptance.mjs';
import Database from 'better-sqlite3';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
async function loadPinnedTarget() {
  const sourceLock = JSON.parse(await readFile(join(root, 'scripts/compatibility/v2-native/source-lock.json'), 'utf8'));
  const evidence = JSON.parse(await readFile(join(root, 'docs/t3-v2-builtin-import-evidence.json'), 'utf8'));
  const sourceArchiveSha256 = createHash('sha256').update(await readFile(join(root, sourceLock.sourceArchive.path))).digest('hex');
  if (sourceLock.t3SourceCommit !== evidence.target.commit) throw new Error('Pinned T3 evidence commit does not match source-lock.json.');
  if (sourceArchiveSha256 !== sourceLock.sourceArchive.sha256) throw new Error('Pinned T3 source archive checksum does not match source-lock.json.');
  return {
    version: evidence.target.version,
    sourceCommit: sourceLock.t3SourceCommit,
    sourceArchiveSha256,
    appImageSha256: evidence.target.appImageSha256,
  };
}
function samplePng() {
  const width = 160;
  const height = 100;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const colors = x < 53 ? [24, 119, 242] : x < 106 ? [132, 86, 245] : [24, 190, 150];
      const border = x < 3 || x >= width - 3 || y < 3 || y >= height - 3;
      const white = (x > 34 && x < 126 && y > 35 && y < 66) || (x > 65 && x < 95 && y > 20 && y < 80);
      pixels[offset] = border ? 24 : white ? 248 : colors[0];
      pixels[offset + 1] = border ? 31 : white ? 250 : colors[1];
      pixels[offset + 2] = border ? 48 : white ? 252 : colors[2];
      pixels[offset + 3] = 255;
    }
  }
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data = Buffer.alloc(0)) => {
    const name = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND')]);
}
const logoPng = samplePng();

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--import-only') {
      options.import_only = true;
    } else if (arg === '--output-dir' || arg === '--appimage' || arg === '--fixture-db' || arg === '--after-view-manifest') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2).replaceAll('-', '_')] = value;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function runAsync(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const { timeout: requestedTimeout, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timeoutMs = requestedTimeout ?? 2 * 60_000;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      killTimer.unref();
    }, timeoutMs);
    timeout.unref();
    let killTimer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      callback(value);
    };
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(rejectRun, error));
    child.once('close', (status, signal) => {
      if (timedOut || status !== 0) {
        const reason = timedOut ? `timed out after ${timeoutMs}ms` : (status ?? signal);
        finish(rejectRun, new Error(`${command} ${args.map((arg) => JSON.stringify(arg)).join(' ')} failed (${reason}):\n${stderr}\n${stdout}`));
        return;
      }
      finish(resolveRun, { stdout, stderr });
    });
  });
}

function appendLine(path, row) {
  return `${JSON.stringify(row)}\n`;
}

export function codexRows(sessionId, workspace, content, turn = 'turn-1') {
  const at = '2026-10-12T12:00:00.000Z';
  const shellAt = '2026-10-12T12:00:01.000Z';
  const planAt = '2026-10-12T12:00:02.000Z';
  const answerAt = '2026-10-12T12:00:03.000Z';
  const completedAt = '2026-10-12T12:00:04.000Z';
  const plan = content.includes('AFTER') ? 'Confirm replacement content in the task.' : 'Inspect the sample image and preserve the session history.';
  return [
    { timestamp: at, type: 'session_meta', payload: { id: sessionId, cwd: workspace, timestamp: at, git_branch: 'gui-acceptance' } },
    { timestamp: at, type: 'turn_context', payload: { model: 'gpt-5.4', cwd: workspace } },
    { timestamp: at, type: 'event_msg', payload: { type: 'task_started', turn_id: turn, started_at: at } },
    { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', id: `${turn}-user`, turn_id: turn, content: [
      { type: 'input_text', text: content },
      { type: 'input_image', image_url: `data:image/png;base64,${logoPng.toString('base64')}` },
    ] } },
    { timestamp: shellAt, type: 'response_item', payload: { type: 'local_shell_call', id: `${turn}-shell`, call_id: `${turn}-shell`, name: 'shell', command: 'printf GUI_FIXTURE_TOOL_OK' } },
    { timestamp: '2026-10-12T12:00:01.500Z', type: 'response_item', payload: { type: 'local_shell_call_output', id: `${turn}-shell-output`, call_id: `${turn}-shell`, output: 'GUI_FIXTURE_TOOL_OK' } },
    { timestamp: planAt, type: 'response_item', payload: { type: 'function_call', id: `${turn}-plan`, call_id: `${turn}-plan`, name: 'update_plan', arguments: JSON.stringify({ explanation: 'Synthetic GUI acceptance history', plan: [{ step: 'Inspect sample image', status: 'completed' }, { step: 'Verify imported task', status: 'completed' }] }) } },
    { timestamp: answerAt, type: 'response_item', payload: { type: 'message', role: 'assistant', id: `${turn}-assistant`, turn_id: turn, content: [{ type: 'output_text', text: content.includes('AFTER') ? 'GUI_CODEX_AFTER_OK: replacement is visible.' : 'GUI_CODEX_BEFORE_OK: image, plan, and command history preserved.' }] } },
    { timestamp: completedAt, type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } },
  ];
}

export function claudeRows(sessionId, workspace, content) {
  const at = '2026-10-12T12:10:00.000Z';
  const userId = `${sessionId}-user`;
  const toolId = `${sessionId}-tool`;
  const resultId = `${sessionId}-result`;
  const assistantId = `${sessionId}-assistant`;
  const plan = content.includes('AFTER') ? 'Confirm replacement content in the task.' : 'Inspect the sample image and preserve the session history.';
  const base = { sessionId, cwd: workspace, isSidechain: false };
  return [
    { ...base, uuid: userId, parentUuid: null, type: 'user', timestamp: at, message: { role: 'user', content: [
      { type: 'text', text: content },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: logoPng.toString('base64') } },
    ] } },
    { ...base, uuid: toolId, parentUuid: userId, type: 'assistant', timestamp: '2026-10-12T12:10:01.000Z', message: { role: 'assistant', model: 'claude-opus-5-5', content: [
      { type: 'tool_use', id: `${sessionId}-bash`, name: 'Bash', input: { command: 'printf GUI_FIXTURE_TOOL_OK' } },
      { type: 'tool_use', id: `${sessionId}-todos`, name: 'TodoWrite', input: { todos: [{ content: 'Inspect sample image', status: 'completed' }, { content: 'Verify imported task', status: 'completed' }] } },
      { type: 'tool_use', id: `${sessionId}-plan`, name: 'ExitPlanMode', input: { plan: `# GUI acceptance plan\n1. ${plan}` } },
    ] } },
    { ...base, uuid: resultId, parentUuid: toolId, type: 'user', timestamp: '2026-10-12T12:10:02.000Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: `${sessionId}-bash`, content: 'GUI_FIXTURE_TOOL_OK' },
    ] } },
    { ...base, uuid: assistantId, parentUuid: resultId, type: 'assistant', timestamp: '2026-10-12T12:10:03.000Z', message: { role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 120, output_tokens: 40 }, content: [{ type: 'text', text: content.includes('AFTER') ? 'GUI_CLAUDE_AFTER_OK: replacement is visible.' : 'GUI_CLAUDE_BEFORE_OK: image, plan, and command history preserved.' }], stop_reason: 'end_turn' } },
  ];
}

export function claudeFollowupRows(sessionId, workspace, turnId, parentUuid, userText = 'Continue the synthetic GUI task.', assistantText = 'Synthetic continuation completed.') {
  const base = { sessionId, cwd: workspace, isSidechain: false };
  const userUuid = `${sessionId}-${turnId}-user`;
  const assistantUuid = `${sessionId}-${turnId}-assistant`;
  return [
    { ...base, uuid: userUuid, parentUuid, type: 'user', timestamp: '2026-10-12T12:11:00.000Z', message: { role: 'user', content: userText } },
    { ...base, uuid: assistantUuid, parentUuid: userUuid, type: 'assistant', timestamp: '2026-10-12T12:11:03.000Z', message: { role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 150, output_tokens: 45 }, content: [{ type: 'text', text: assistantText }], stop_reason: 'end_turn' } },
  ];
}

async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
}

async function directoryFingerprint(path) {
  const files = [];
  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) files.push([relative(path, file), createHash('sha256').update(await readFile(file)).digest('hex')]);
    }
  }
  await walk(path);
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

function resolveCliPathArgs(outputDir, rawArgs, source) {
  const args = [...rawArgs];
  for (let index = 0; index < args.length; index += 1) {
    if (['--t3-home', '--db', '--attachments-dir', '--workspace'].includes(args[index])) {
      args[index + 1] = fixturePath(outputDir, args[index + 1], `${source} ${args[index]}`);
      index += 1;
    }
  }
  return args;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
      console.log('Usage: node scripts/compatibility/v2-native/gui-fixture.mjs --output-dir <new-unique-dir> [--appimage PATH] [--fixture-db PATH] [--import-only]\n       node scripts/compatibility/v2-native/gui-fixture.mjs --after-view-manifest <fixture-manifest.json>');
    return;
  }
  if (options.after_view_manifest) {
    await runAfterView(options.after_view_manifest);
    return;
  }
  const pinnedTarget = await loadPinnedTarget();
  if (!options.output_dir) throw new Error('Usage: --output-dir <new-unique-dir> [--appimage PATH] [--fixture-db PATH] [--import-only]');
  const outputDir = resolve(options.output_dir);
  if (existsSync(outputDir)) throw new Error(`Refusing to reuse existing output directory: ${outputDir}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });

  const privateHome = join(outputDir, 'home');
  const xdgConfig = join(outputDir, 'xdg-config');
  const xdgData = join(outputDir, 'xdg-data');
  const t3Home = join(outputDir, 't3-home');
  const ledger = join(outputDir, 'ledger');
  const project = join(outputDir, 'project');
  const codexHome = join(outputDir, 'sources', 'codex');
  const claudeHome = join(outputDir, 'sources', 'claude');
  const dbPath = join(t3Home, 'userdata', 'statev2.sqlite');
  const appimage = options.appimage ? resolve(options.appimage) : undefined;
  const fixtureDb = options.fixture_db ? resolve(options.fixture_db) : process.env.T3_V2_FIXTURE_DB ? resolve(process.env.T3_V2_FIXTURE_DB) : undefined;
  for (const directory of [privateHome, xdgConfig, xdgData, t3Home, ledger, project, codexHome, claudeHome]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
  await writeFile(join(project, 'README.md'), 'Synthetic T3 GUI acceptance project. No private data.\n', { mode: 0o600 });
  await writeFile(join(outputDir, 'sample.png'), logoPng, { mode: 0o600 });

  let appimagePin = { status: 'unavailable', reason: 'No AppImage supplied; desktop pin was not verified.' };
  if (appimage) {
    const digest = createHash('sha256').update(await readFile(appimage)).digest('hex');
    if (digest !== pinnedTarget.appImageSha256) throw new Error(`AppImage pin mismatch: expected ${pinnedTarget.appImageSha256}, got ${digest}`);
    appimagePin = { status: 'verified', sha256: digest, version: pinnedTarget.version, sourceCommit: pinnedTarget.sourceCommit };
  }

  if (!fixtureDb) throw new Error('A clean pinned T3 v2 database is required: pass --fixture-db PATH or set T3_V2_FIXTURE_DB.');
  if (!existsSync(fixtureDb)) throw new Error(`Fixture database does not exist: ${fixtureDb}`);
  await writeFile(dbPath, await readFile(fixtureDb), { mode: 0o600, flag: 'wx' });

  const cli = join(root, 'dist', 'cli.js');
  if (!existsSync(cli)) throw new Error('Built CLI is missing; run npm run build first.');
  const environment = {
    HOME: privateHome,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    T3CODE_HOME: t3Home,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    T3_IMPORT_DATA_DIR: ledger,
    T3CODE_DISABLE_AUTO_UPDATE: '1',
  };
  const manifestEnvironment = Object.fromEntries(Object.entries(environment).map(([name, value]) => [
    name,
    [privateHome, xdgConfig, xdgData, t3Home, codexHome, claudeHome, ledger].includes(value) ? relative(outputDir, value) || '.' : value,
  ]));
  const marker = `GUI_FIXTURE_${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  await writeFile(join(outputDir, '.gui-fixture-marker'), marker, { mode: 0o600, flag: 'wx' });
  const providers = {};
  for (const source of ['codex', 'claude']) {
    const sessionId = randomUUID();
    const workspace = join(project, source);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const before = `${marker}_${source.toUpperCase()}_BEFORE: inspect the sample image and preserve the plan.`;
    const after = `${marker}_${source.toUpperCase()}_AFTER: replacement history with the same image.`;
    const sourceFile = source === 'codex'
      ? join(codexHome, 'sessions', '2026', '10', '12', `rollout-${sessionId}.jsonl`)
      : join(claudeHome, 'projects', 'gui-acceptance', `${sessionId}.jsonl`);
    await writeJsonl(sourceFile, source === 'codex' ? codexRows(sessionId, workspace, before) : claudeRows(sessionId, workspace, before));
    const relativeWorkspace = relative(outputDir, workspace);
    const relativeT3Home = relative(outputDir, t3Home);
    const relativeDbPath = relative(outputDir, dbPath);
    const relativeAttachments = relative(outputDir, join(t3Home, 'userdata', 'attachments'));
    const baseArgs = [cli, '--t3-home', t3Home, '--db', dbPath, '--attachments-dir', join(t3Home, 'userdata', 'attachments'), '--provider-instance', source === 'codex' ? 'codex' : 'claudeAgent', '--json', '--no-cache-reset'];
    const execute = async (args) => {
      const result = await serializeByTarget(dbPath, () => runAsync(process.execPath, [...baseArgs, ...args], { cwd: root, env: environment }));
      try { return JSON.parse(result.stdout); }
      catch { throw new Error(`CLI returned non-JSON output for ${source} ${args[0]}: ${result.stdout}`); }
    };
    const importResult = await execute(['import', '--source', source, '--workspace', workspace, '--thread', sessionId, '--yes']);
    const importedThreadId = importResult.results?.[0]?.threadId;
    if (importResult.status !== 'imported' || !importedThreadId) throw new Error(`${source} import did not return one imported task: ${JSON.stringify(importResult)}`);
    let syncFirst;
    let syncSecond;
    let replacementPreview;
    if (!options.import_only) {
      syncFirst = await execute(['sync', '--source', source, '--workspace', workspace, '--thread', sessionId, '--yes']);
      syncSecond = await execute(['sync', '--source', source, '--workspace', workspace, '--thread', sessionId, '--yes']);
      const firstStatus = syncFirst.results?.[0]?.status;
      const secondStatus = syncSecond.results?.[0]?.status;
    if (firstStatus !== 'up-to-date' || secondStatus !== 'up-to-date') throw new Error(`${source} serial sync was not idempotent: ${firstStatus}, ${secondStatus}`);
      await writeJsonl(sourceFile, source === 'codex' ? codexRows(sessionId, workspace, after) : claudeRows(sessionId, workspace, after));
      const ledgerBeforePreview = await directoryFingerprint(ledger);
      const nativeEventsBeforePreview = await nativeEventFingerprint(dbPath);
      replacementPreview = await execute(['replace', '--source', source, '--workspace', workspace, '--thread', sessionId, '--dry-run', '--yes']);
      const replacementRow = replacementPreview.results?.[0];
      const ledgerUnchanged = ledgerBeforePreview === await directoryFingerprint(ledger);
      const nativeEventsUnchanged = nativeEventsBeforePreview === await nativeEventFingerprint(dbPath);
      if (replacementPreview.status !== 'dry-run' || replacementPreview.hasConflicts !== false
        || replacementPreview.results?.length !== 1 || replacementRow?.status !== 'dry-run'
        || replacementRow.oldThreadId !== importedThreadId || !replacementRow.newThreadId
        || replacementPreview.backup !== null || !nativeEventsUnchanged || !ledgerUnchanged) {
        throw new Error(`${source} replacement preview was not a clean, non-mutating plan for the imported task: ${JSON.stringify({ status: replacementPreview.status, hasConflicts: replacementPreview.hasConflicts, row: replacementRow, ledgerUnchanged, nativeEventsUnchanged })}`);
      }
    }
    providers[source] = {
      sourceThreadId: sessionId,
      threadId: importedThreadId,
      workspace: relativeWorkspace,
      t3Home: relativeT3Home,
      sourceHome: source === 'codex' ? 'sources/codex' : 'sources/claude',
      sourceFile: relative(outputDir, sourceFile),
      markers: { before, after },
      environment: manifestEnvironment,
      nodeExecutable: process.execPath,
      cliScript: 'dist/cli.js',
      commandPathBase: 'repository-root; resolve fixture-relative option values against output root',
      workingDirectory: '.',
      commands: {
        import: ['node', 'dist/cli.js', '--t3-home', relativeT3Home, '--db', relativeDbPath, '--attachments-dir', relativeAttachments, '--provider-instance', source === 'codex' ? 'codex' : 'claudeAgent', '--json', '--no-cache-reset', 'import', '--source', source, '--workspace', relativeWorkspace, '--thread', sessionId, '--yes'],
        sync: ['node', 'dist/cli.js', '--t3-home', relativeT3Home, '--db', relativeDbPath, '--attachments-dir', relativeAttachments, '--provider-instance', source === 'codex' ? 'codex' : 'claudeAgent', '--json', '--no-cache-reset', 'sync', '--source', source, '--workspace', relativeWorkspace, '--thread', sessionId, '--yes'],
        syncRepeat: ['node', 'dist/cli.js', '--t3-home', relativeT3Home, '--db', relativeDbPath, '--attachments-dir', relativeAttachments, '--provider-instance', source === 'codex' ? 'codex' : 'claudeAgent', '--json', '--no-cache-reset', 'sync', '--source', source, '--workspace', relativeWorkspace, '--thread', sessionId, '--yes'],
        replacementPreview: ['node', 'dist/cli.js', '--t3-home', relativeT3Home, '--db', relativeDbPath, '--attachments-dir', relativeAttachments, '--provider-instance', source === 'codex' ? 'codex' : 'claudeAgent', '--json', '--no-cache-reset', 'replace', '--source', source, '--workspace', relativeWorkspace, '--thread', sessionId, '--dry-run', '--yes'],
        replacementAfterViewingOriginalTask: ['node', 'dist/cli.js', '--t3-home', relativeT3Home, '--db', relativeDbPath, '--attachments-dir', relativeAttachments, '--provider-instance', source === 'codex' ? 'codex' : 'claudeAgent', '--json', '--no-cache-reset', 'replace', '--source', source, '--workspace', relativeWorkspace, '--thread', sessionId, '--yes'],
      },
      results: { import: importResult, ...(syncFirst ? { syncFirst, syncSecond, replacementPreview } : {}) },
      validation: syncFirst ? {
        serialIdempotentSync: syncFirst.results?.[0]?.status === 'up-to-date' && syncSecond.results?.[0]?.status === 'up-to-date',
        replacementPreview: 'planned',
        previewTargetMatchesImportedTask: replacementPreview.results?.[0]?.oldThreadId === importedThreadId,
        nativeEventsUnchanged: true,
        ledgerUnchanged: true,
      } : { importedWithBuiltCli: true },
    };
  }

  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    fixtureMarker: marker,
    pin: { t3Version: pinnedTarget.version, t3SourceCommit: pinnedTarget.sourceCommit, sourceArchiveSha256: pinnedTarget.sourceArchiveSha256, appimage: appimagePin },
    pathsRelativeTo: '.',
    sampleImage: { file: 'sample.png', width: 160, height: 100, description: 'Synthetic three-color block image with a white T mark and dark border.' },
    isolation: { outputDir: '.', home: 'home', xdgConfig: 'xdg-config', xdgData: 'xdg-data', t3Home: 't3-home', dbPath: 't3-home/userdata/statev2.sqlite', ledger: 'ledger', codexHome: 'sources/codex', claudeHome: 'sources/claude', project: 'project' },
    safety: { syntheticProviderLogs: true, credentialsCreated: false, hostHomesRead: false, hostHomesModified: false, callerOwnsOutputAndCleanup: true },
    providers,
  };
  const redactGeneratedPaths = (value) => {
    if (typeof value === 'string') return value.startsWith(outputDir) ? `.${value.slice(outputDir.length)}` : value;
    if (Array.isArray(value)) return value.map(redactGeneratedPaths);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactGeneratedPaths(nested)]));
    return value;
  };
  const safeManifest = redactGeneratedPaths(manifest);
  await writeFile(join(outputDir, 'fixture-manifest.json'), `${JSON.stringify(safeManifest, null, 2)}\n`, { mode: '0600' });
  console.log(JSON.stringify(safeManifest));
}

async function nativeEventFingerprint(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const events = db.prepare('SELECT * FROM orchestration_events ORDER BY sequence').all();
    return createHash('sha256').update(JSON.stringify(events)).digest('hex');
  } finally {
    db.close();
  }
}

async function databaseFingerprint(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const contents = tables.map(({ name }) => {
      const quoted = `"${String(name).replaceAll('"', '""')}"`;
      const rows = db.prepare(`SELECT * FROM ${quoted}`).all().map((row) => JSON.stringify(row)).sort();
      return [name, rows];
    });
    return createHash('sha256').update(JSON.stringify(contents)).digest('hex');
  } finally {
    db.close();
  }
}

function fixturePath(outputDir, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.startsWith('/') || relativePath.includes('\\')) {
    throw new Error(`Invalid relative ${label} path in fixture manifest.`);
  }
  const absolute = resolve(outputDir, relativePath);
  const rel = relative(outputDir, absolute);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`${label} path escapes the fixture output directory.`);
  return absolute;
}

async function runAfterView(manifestPathArg) {
  const manifestPath = resolve(manifestPathArg);
  const outputDir = dirname(manifestPath);
  const reportPath = join(outputDir, 'after-view-results.json');
  if (existsSync(reportPath)) throw new Error(`Refusing to overwrite existing after-view report: ${reportPath}`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.pathsRelativeTo !== '.' || manifest.safety?.syntheticProviderLogs !== true
    || manifest.safety?.credentialsCreated !== false || manifest.safety?.hostHomesModified !== false) {
    throw new Error('Refusing post-view mutation: manifest is not a recognized synthetic fixture.');
  }
  if (!manifest.fixtureMarker || await readFile(join(outputDir, '.gui-fixture-marker'), 'utf8') !== manifest.fixtureMarker) {
    throw new Error('Refusing post-view mutation: fixture marker is missing or does not match.');
  }
  const pinnedTarget = await loadPinnedTarget();
  if (manifest.pin?.t3Version !== pinnedTarget.version || manifest.pin?.t3SourceCommit !== pinnedTarget.sourceCommit
    || manifest.pin?.sourceArchiveSha256 !== pinnedTarget.sourceArchiveSha256
    || (manifest.pin?.appimage?.status === 'verified' && manifest.pin.appimage.sha256 !== pinnedTarget.appImageSha256)) {
    throw new Error('Refusing post-view mutation: fixture pin does not match the checked-in verified target.');
  }
  const databasePath = fixturePath(outputDir, manifest.isolation?.dbPath, 'database');
  const ledgerPath = fixturePath(outputDir, manifest.isolation?.ledger, 'ledger');
  const cli = join(root, 'dist', 'cli.js');
  if (!existsSync(cli) || !existsSync(databasePath)) throw new Error('Post-view fixture database or built CLI is missing.');
  const sourceMap = { codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR' };
  const environment = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' };
  for (const [key, value] of Object.entries(manifest.providers?.codex?.environment ?? {})) {
    if (['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'T3CODE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'T3_IMPORT_DATA_DIR'].includes(key)) {
      environment[key] = fixturePath(outputDir, value, key);
    } else if (key === 'T3CODE_DISABLE_AUTO_UPDATE' && value === '1') environment[key] = value;
  }
  const providers = {};
  for (const source of ['codex', 'claude']) {
    const entry = manifest.providers?.[source];
    if (!entry || !sourceMap[source]) throw new Error(`Fixture manifest has no ${source} provider entry.`);
    const sourceHomeKey = sourceMap[source];
    if (resolve(environment[sourceHomeKey]) !== fixturePath(outputDir, entry.sourceHome, `${source} source home`)) {
      throw new Error(`${source} provider home does not match the isolated fixture source path.`);
    }
    const workspace = fixturePath(outputDir, entry.workspace, `${source} workspace`);
    const sourceFile = fixturePath(outputDir, entry.sourceFile, `${source} source transcript`);
    if (!existsSync(sourceFile)) throw new Error(`Missing ${source} source transcript for after-view replacement.`);
    const commands = entry.commands?.replacementAfterViewingOriginalTask;
    if (!Array.isArray(commands) || commands[0] !== 'node' || commands[1] !== 'dist/cli.js') {
      throw new Error(`Invalid ${source} post-view command contract.`);
    }
    const args = resolveCliPathArgs(outputDir, commands.slice(2), source);
    if (!args.includes('--yes') || args.includes('--dry-run') || !args.includes(entry.sourceThreadId) || !args.includes(workspace)) {
      throw new Error(`${source} replacement command does not target the isolated source and target paths.`);
    }
    const operation = async (commandArgs) => {
      const result = await runAsync(process.execPath, [cli, ...commandArgs], { cwd: root, env: environment });
      try { return JSON.parse(result.stdout); }
      catch { throw new Error(`${source} post-view CLI returned invalid JSON.`); }
    };
    const replacement = await serializeByTarget(databasePath, () => operation(args));
    const row = replacement.results?.[0];
    if (replacement.status !== 'replaced' || replacement.hasConflicts || replacement.results?.length !== 1
      || row?.status !== 'replaced' || row.oldThreadId !== entry.threadId || !row.newThreadId) {
      throw new Error(`${source} post-view replacement did not replace the imported task: ${JSON.stringify({ status: replacement.status, row })}`);
    }
    const databaseAfterReplace = await databaseFingerprint(databasePath);
    const eventsAfterReplace = await nativeEventFingerprint(databasePath);
    const ledgerAfterReplace = await directoryFingerprint(ledgerPath);
    const syncCommand = entry.commands.sync;
    if (!Array.isArray(syncCommand) || syncCommand[0] !== 'node' || syncCommand[1] !== 'dist/cli.js') throw new Error(`Invalid ${source} sync command contract.`);
    const syncArgs = resolveCliPathArgs(outputDir, syncCommand.slice(2), source);
    const firstSync = await serializeByTarget(databasePath, () => operation(syncArgs));
    const secondSync = await serializeByTarget(databasePath, () => operation(syncArgs));
    const syncRows = [firstSync.results?.[0], secondSync.results?.[0]];
    if (syncRows.some((item) => item?.status !== 'up-to-date' || item.turnsAdded !== 0 || item.events !== 0)
      || databaseAfterReplace !== await databaseFingerprint(databasePath)
      || eventsAfterReplace !== await nativeEventFingerprint(databasePath)
      || ledgerAfterReplace !== await directoryFingerprint(ledgerPath)) {
      throw new Error(`${source} post-replacement sync was not a zero-change repeat: ${JSON.stringify({ statuses: syncRows.map((item) => item?.status) })}`);
    }
    providers[source] = {
      importedThreadId: entry.threadId,
      replacement: { status: row.status, oldThreadId: row.oldThreadId, newThreadId: row.newThreadId },
      sync: syncRows.map((item) => ({ status: item.status, turnsAdded: item.turnsAdded, events: item.events })),
      stableAfterReplacement: true,
    };
  }
  const report = { schemaVersion: 1, status: 'passed', pin: { t3Version: manifest.pin.t3Version, t3SourceCommit: manifest.pin.t3SourceCommit, sourceArchiveSha256: manifest.pin.sourceArchiveSha256, appimage: manifest.pin.appimage }, providers };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
