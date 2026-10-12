import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
