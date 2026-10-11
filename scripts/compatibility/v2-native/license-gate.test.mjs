import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readPackageLicenseNotices, assertCompleteLicenseNotices } from './license-gate.mjs';

const fixture = await mkdtemp(join(process.cwd(), 'artifacts/v2-native/license-gate-fixture-'));
const lowercasePackage = join(fixture, 'lowercase-package');
const missingPackage = join(fixture, 'missing-package');
await mkdir(lowercasePackage, { recursive: true });
await mkdir(missingPackage, { recursive: true });
await writeFile(join(lowercasePackage, 'license'), 'Copyright Example Authors\nMIT License\n');
const notices = await readPackageLicenseNotices(lowercasePackage, { name: 'sample-lowercase', version: '1.0.0', license: 'MIT' });
assert.equal(notices.length, 1);
assert.match(notices[0].text, /Copyright Example Authors/);
await assert.rejects(
  () => readPackageLicenseNotices(missingPackage, { name: 'sample-missing', version: '1.0.0', license: 'MIT' }),
  /No bundled license text found for sample-missing@1.0.0/,
);
assert.throws(() => assertCompleteLicenseNotices([{ name: 'sample-missing', version: '1.0.0', licenseFiles: [] }]), /sample-missing@1.0.0/);
console.log('license gate: lowercase license discovery and missing-notice failure PASS');
