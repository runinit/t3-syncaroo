import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeIsolatedEnvironment, createFreshOutput, serializeByTarget } from './acceptance.mjs';

test('fresh output refuses existing paths and never empties them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'v2-acceptance-test-'));
  try {
    const existing = join(root, 'keep');
    await import('node:fs/promises').then(({ mkdir, writeFile }) => mkdir(existing).then(() => writeFile(join(existing, 'keep.txt'), 'preserve')));
    await assert.rejects(createFreshOutput(existing), /already exists/u);
    assert.equal(await import('node:fs/promises').then(({ readFile }) => readFile(join(existing, 'keep.txt'), 'utf8')), 'preserve');
    const created = await createFreshOutput(join(root, 'fresh'));
    assert.equal(created, join(root, 'fresh'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('isolated env routes provider and T3 homes into the run directory and drops auth env', () => {
  const env = makeIsolatedEnvironment('/tmp/v2-run', { HOME: '/home/real', CODEX_HOME: '/real/codex', ANTHROPIC_API_KEY: 'secret', PATH: '/bin' });
  assert.equal(env.HOME, '/tmp/v2-run/home');
  assert.equal(env.CODEX_HOME, '/tmp/v2-run/providers/codex');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/v2-run/providers/claude');
  assert.equal(env.T3_IMPORT_DATA_DIR, '/tmp/v2-run/ledger');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.PATH, '/bin');
});

test('operations for one target serialize even when caller starts promises together', async () => {
  const order = [];
  const first = serializeByTarget('codex:/tmp/isolated/state.sqlite', async () => {
    order.push('first:start'); await new Promise((resolve) => setTimeout(resolve, 20)); order.push('first:end');
  });
  const second = serializeByTarget('codex:/tmp/isolated/state.sqlite', async () => { order.push('second:start'); });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
});

test('pinned test stops before source preparation when typecheck fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'v2-pinned-preflight-test-'));
  try {
    const scripts = join(root, 'scripts/compatibility/v2-native');
    const proof = join(root, 'scripts/compatibility/v2-proof');
    const fakeBin = join(root, 'fake-bin');
    await mkdir(scripts, { recursive: true });
    await mkdir(proof, { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await copyFile(new URL('./pinned-test.mjs', import.meta.url), join(scripts, 'pinned-test.mjs'));
    await copyFile(new URL('./source-lock.json', import.meta.url), join(scripts, 'source-lock.json'));
    const preparedMarker = join(root, 'prepared');
    await writeFile(join(proof, 'prepare.mjs'), `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(preparedMarker)}, 'prepared');\n`);
    const npmCalls = join(root, 'npm-calls');
    const npmPath = join(fakeBin, 'npm');
    await writeFile(npmPath, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(npmCalls)}\nexit 37\n`);
    await chmod(npmPath, 0o755);

    const result = spawnSync(process.execPath, [join(scripts, 'pinned-test.mjs')], {
      cwd: root,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0, 'pinned test must propagate the typecheck failure');
    assert.deepEqual((await readFile(npmCalls, 'utf8')).trim().split('\n'), ['run typecheck']);
    await assert.rejects(readFile(preparedMarker), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
