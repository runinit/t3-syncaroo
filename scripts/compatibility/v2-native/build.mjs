import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertCompleteLicenseNotices, readPackageLicenseNotices } from './license-gate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceLockPath = join(root, 'scripts/compatibility/v2-native/source-lock.json');
const buildToolLockPath = join(root, 'scripts/compatibility/v2-native/build-tool-lock.json');
const sourceLock = JSON.parse(await readFile(sourceLockPath, 'utf8'));
const buildToolLock = JSON.parse(await readFile(buildToolLockPath, 'utf8'));
const commit = sourceLock.t3SourceCommit;
const t3Root = join(root, 'artifacts/t3-reference', `t3code-${commit}`);
const archive = join(root, sourceLock.sourceArchive.path);
const pnpmLockPath = join(t3Root, 'pnpm-lock.yaml');
const outRoot = join(root, 'artifacts/v2-native');
const candidate = join(outRoot, 'candidate');
const helper = join(outRoot, 'helper.mjs');
const metafile = join(outRoot, 'meta.json');
const fixture = join(outRoot, 'fixture.mjs');
const fixtureMeta = join(outRoot, 'fixture-meta.json');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha512Integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stderr ?? ''}`);
  return result;
}
function parsePackJson(text) {
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : Object.values(parsed);
}

// Pin the downloaded source artifact, dependency lock, and every T3 file in the
// helper and fixture metafiles before compiling any code.
if (sha256(await readFile(archive)) !== sourceLock.sourceArchive.sha256) {
  throw new Error(`Pinned T3 release archive checksum mismatch: ${archive}`);
}
if (sha256(await readFile(pnpmLockPath)) !== sourceLock.pnpmLockSha256) {
  throw new Error(`Pinned T3 pnpm-lock.yaml checksum mismatch: ${pnpmLockPath}`);
}
for (const source of [...sourceLock.sourceFiles, ...sourceLock.fixtureSourceFiles]) {
  const sourcePath = join(t3Root, source.path);
  if (sha256(await readFile(sourcePath)) !== source.sha256) {
    throw new Error(`Pinned T3 source checksum mismatch: ${source.path}`);
  }
}

// Fetch exact build-tool tarballs and verify their npm SRI values before use.
// The proof currently pins the Linux x64 build host. Other build platforms need
// their own integrity entry before the tool may be used there.
const buildToolDir = await mkdtemp(join(outRoot, 'build-tool-'));
const packDir = join(buildToolDir, 'tarballs');
await mkdir(packDir, { recursive: true });
const specs = buildToolLock.packages.map((pkg) => `${pkg.name}@${pkg.version}`);
const packed = run('npm', ['pack', ...specs, '--json', '--workspaces=false', '--pack-destination', packDir], { cwd: root });
const packDetails = parsePackJson(packed.stdout);
for (const pinned of buildToolLock.packages) {
  const detail = packDetails.find((item) => item.name === pinned.name && item.version === pinned.version);
  if (!detail) throw new Error(`npm pack omitted pinned build tool ${pinned.name}@${pinned.version}`);
  const tarball = join(packDir, detail.filename);
  if (sha512Integrity(await readFile(tarball)) !== pinned.integrity) {
    throw new Error(`Pinned build-tool tarball integrity mismatch: ${pinned.name}@${pinned.version}`);
  }
  const packageDir = pinned.name === 'esbuild'
    ? join(buildToolDir, 'node_modules/esbuild')
    : join(buildToolDir, 'node_modules', pinned.name);
  await mkdir(packageDir, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', packageDir, '--strip-components=1']);
}
const esbuildBin = join(buildToolDir, 'node_modules/esbuild/bin/esbuild');
const esbuildVersion = run(process.execPath, [esbuildBin, '--version']).stdout.trim();
if (esbuildVersion !== '0.25.12') throw new Error(`Unexpected esbuild version: ${esbuildVersion}`);

const aliasArgs = [
  `--alias:effect=${join(t3Root, 'packages/contracts/node_modules/effect/dist')}`,
  `--alias:@t3tools/contracts=${join(t3Root, 'packages/contracts/src/index.ts')}`,
];
function bundle(entry, outfile, metaPath, aliases = []) {
  run(process.execPath, [esbuildBin, entry, '--bundle', '--platform=node', '--format=esm', '--target=node22', '--packages=bundle',
    ...aliases, `--outfile=${outfile}`, `--metafile=${metaPath}`], { cwd: root, stdio: 'inherit' });
}
bundle('scripts/compatibility/v2-native/helper.ts', helper, metafile, aliasArgs);
bundle('scripts/compatibility/v2-native/fixture.ts', fixture, fixtureMeta,
  [`--alias:effect=${join(t3Root, 'packages/contracts/node_modules/effect/dist')}`]);

await mkdir(candidate, { recursive: true });
await cp(helper, join(candidate, 'helper.mjs'));
const pkg = { name: '@t3-import/t3-v2-native-proof', version: '0.0.0-proof', private: true, type: 'module',
  engines: { node: '>=22.16.0' }, files: ['helper.mjs', 'LICENSES.md', 'PROVENANCE.json'] };
await writeFile(join(candidate, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

const meta = JSON.parse(await readFile(metafile, 'utf8'));
const files = Object.keys(meta.inputs);
const own = files.filter((p) => p.includes(`/t3code-${commit}/`) && !p.includes('/node_modules/'));
const dependencyPaths = files.filter((p) => p.includes('/node_modules/.pnpm/'));
const packageRoots = new Map();
for (const input of dependencyPaths) {
  const marker = '/node_modules/.pnpm/';
  const i = input.indexOf(marker);
  const item = input.slice(i + marker.length).split('/node_modules/');
  if (item.length < 2) continue;
  let packageName = item[1].split('/')[0];
  if (packageName.startsWith('@')) packageName += `/${item[1].split('/')[1]}`;
  const packageRoot = input.slice(0, i + marker.length) + item[0] + `/node_modules/${packageName}`;
  packageRoots.set(packageRoot, packageName);
}

const lockText = await readFile(pnpmLockPath, 'utf8');
const packagesStart = lockText.indexOf('\npackages:\n') + '\npackages:\n'.length;
const snapshotsStart = lockText.indexOf('\nsnapshots:\n', packagesStart);
if (packagesStart < 0 || snapshotsStart < 0) throw new Error('Unexpected pnpm lockfile layout; cannot verify dependency provenance');
const packageLockSection = lockText.slice(packagesStart, snapshotsStart);
const packageEntries = [];
for (const [packageRoot, fallbackName] of packageRoots) {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const name = packageJson.name ?? fallbackName;
  const version = packageJson.version;
  if (!version || packageJson.license == null || packageJson.license === 'UNLICENSED') {
    throw new Error(`Missing version or declared license metadata for bundled dependency ${name}`);
  }
  const keyPrefix = `${name}@${version}`;
  const lines = packageLockSection.split('\n');
  const matchingBlocks = [];
  for (let i = 0; i < lines.length; i++) {
    const keyMatch = lines[i].match(/^  (?:'([^']+)'|"([^"]+)"|([^:]+)):\s*$/);
    if (!keyMatch) continue;
    const key = keyMatch[1] ?? keyMatch[2] ?? keyMatch[3];
    if (key !== keyPrefix && !key.startsWith(`${keyPrefix}(`)) continue;
    let block = '';
    for (let j = i + 1; j < lines.length && !/^  \S/.test(lines[j]); j++) block += `${lines[j]}\n`;
    const integrity = block.match(/integrity:\s*([^\s,}]+)/)?.[1];
    if (integrity) matchingBlocks.push({ key, integrity });
  }
  const integrities = [...new Set(matchingBlocks.map((entry) => entry.integrity))];
  if (integrities.length !== 1) throw new Error(`Could not resolve unique pinned package integrity for ${name}@${version} from pnpm-lock.yaml`);

  const licenseFiles = await readPackageLicenseNotices(packageRoot, packageJson);
  packageEntries.push({ name, version, license: packageJson.license, pnpmIntegrity: integrities[0], licenseFiles });
}
packageEntries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
assertCompleteLicenseNotices(packageEntries);
const ownLicense = await readFile(join(t3Root, 'LICENSE'), 'utf8');
const notices = [`# Third-party notices\n\nPinned T3 Code source commit: \`${commit}\` (MIT).\n\n${ownLicense}\n\n## Bundled dependency licenses\n\nLicense files are copied from installed packages whose exact versions and tarball integrities are pinned in the T3 pnpm lockfile.\n`];
for (const dependency of packageEntries) {
  notices.push(`\n### ${dependency.name}@${dependency.version} — ${dependency.license}\n`);
  for (const license of dependency.licenseFiles) notices.push(`\n#### ${license.file}\n\n${license.text}\n`);
}
const noticeText = notices.join('\n');
if (noticeText.includes('(No license file found') || noticeText.includes('(Package metadata not resolved)')) {
  throw new Error('Incomplete generated license notices');
}
await writeFile(join(candidate, 'LICENSES.md'), noticeText);
await writeFile(join(root, 'scripts/compatibility/v2-native/LICENSES.md'), noticeText);

const helperBytes = await readFile(join(candidate, 'helper.mjs'));
const archiveBytes = await readFile(archive);
const provenance = {
  t3SourceCommit: commit,
  t3ReleaseArchiveSha256: sha256(archiveBytes),
  t3PnpmLockSha256: sha256(await readFile(pnpmLockPath)),
  bundledHelperSha256: sha256(helperBytes),
  esbuildVersion,
  esbuildTarballIntegrities: buildToolLock.packages.map(({ name, version, integrity }) => ({ name, version, integrity })),
  nodeTarget: 'node22',
  sourceFiles: own.map((p) => p.slice(p.indexOf(`/t3code-${commit}/`) + `/t3code-${commit}/`.length)).sort(),
  bundledDependencyCount: packageEntries.length,
  bundledDependencyLicenses: packageEntries.map(({ name, version, license, pnpmIntegrity, licenseFiles }) => ({
    name, version, license, pnpmIntegrity, licenseFiles: licenseFiles.map(({ file, text }) => ({ file, sha256: sha256(Buffer.from(text)) })),
  })),
};
await writeFile(join(candidate, 'PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`);
await writeFile(join(root, 'scripts/compatibility/v2-native/vendor-manifest.json'), `${JSON.stringify(provenance, null, 2)}\n`);

const externals = meta.outputs[Object.keys(meta.outputs)[0]].imports.filter((item) => item.external).map((item) => item.path);
if (externals.some((item) => !item.startsWith('node:'))) throw new Error(`Non-builtin runtime external: ${externals.filter((item) => !item.startsWith('node:')).join(', ')}`);
const packResult = run('npm', ['pack', '--json', '--workspaces=false', '--pack-destination', outRoot], { cwd: candidate });
const details = parsePackJson(packResult.stdout)[0];
const tarball = join(outRoot, details.filename);
const consumer = await mkdtemp(join(outRoot, 'clean-consumer-'));
run('tar', ['-xzf', tarball, '-C', consumer]);
const dbPath = join(consumer, 'fixture-home', 'statev2.sqlite');
const init = spawnSync(process.execPath, [fixture, dbPath], { cwd: consumer, encoding: 'utf8' });
if (init.status !== 0) throw new Error(`Fixture migration failed:\n${init.stderr}`);
const replay = spawnSync(process.execPath, [join(consumer, 'package/helper.mjs'), dbPath], {
  cwd: consumer, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' },
});
if (replay.status !== 0) throw new Error(`Unpacked helper failed:\n${replay.stderr}`);
const proof = JSON.parse(replay.stdout.trim().split('\n').at(-1));
if (proof.result !== 'PASS' || !proof.rollback || !proof.closeReopen) throw new Error('Unpacked helper acceptance failed');
console.log(JSON.stringify({ candidate, tarball, packBytes: details.size, unpackedBytes: details.unpackedSize,
  bundledDependencyCount: packageEntries.length, externalRuntimeImports: externals, sourceFileCount: own.length,
  helperSha256: provenance.bundledHelperSha256, allLicenseFilesPresent: packageEntries.every((pkg) => pkg.licenseFiles.length > 0),
  buildInputChecks: 'T3 archive, pnpm lock, traced T3 sources, and esbuild tarballs verified',
  unpackedConsumerRun: proof.result, consumerDirectory: consumer }, null, 2));
