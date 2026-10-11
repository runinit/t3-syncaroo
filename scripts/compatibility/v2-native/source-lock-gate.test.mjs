import assert from 'node:assert/strict';
import { assertExactSourceSet } from './source-lock-gate.mjs';

assert.doesNotThrow(() => assertExactSourceSet('fixture', ['a.ts', 'b.ts'], ['b.ts', 'a.ts']));
assert.throws(() => assertExactSourceSet('fixture', ['a.ts', 'b.ts'], ['a.ts']), /missing: b.ts/);
assert.throws(() => assertExactSourceSet('fixture', ['a.ts'], ['a.ts', 'unexpected.ts']), /unexpected: unexpected.ts/);
console.log('source lock gate: exact set, missing path, and unexpected path checks PASS');
