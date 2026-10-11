import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const commit = 'ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e';
const t3Root = join(root, 'artifacts/t3-reference', `t3code-${commit}`);
const outRoot = join(root, 'artifacts/v2-native');
const candidate = join(outRoot, 'candidate');
const helper = join(outRoot, 'helper.mjs');
const metafile = join(outRoot, 'meta.json');
const fixture = join(outRoot, 'fixture.mjs');
const esbuild = spawnSync('npx', ['--yes', 'esbuild@0.25.12',
  'scripts/compatibility/v2-native/helper.ts', '--bundle', '--platform=node', '--format=esm', '--target=node22',
  '--packages=bundle', `--alias:effect=${join(t3Root, 'packages/contracts/node_modules/effect/dist')}`,
  `--alias:@t3tools/contracts=${join(t3Root, 'packages/contracts/src/index.ts')}`,
  `--outfile=${helper}`, `--metafile=${metafile}`], { cwd: root, stdio: 'inherit' });
if (esbuild.error) throw esbuild.error;
if (esbuild.status !== 0) process.exit(esbuild.status ?? 1);
const fixtureBuild = spawnSync('npx', ['--yes', 'esbuild@0.25.12',
  'scripts/compatibility/v2-native/fixture.ts', '--bundle', '--platform=node', '--format=esm', '--target=node22',
  '--packages=bundle', `--alias:effect=${join(t3Root, 'packages/contracts/node_modules/effect/dist')}`,
  `--outfile=${fixture}`, `--metafile=${join(outRoot,'fixture-meta.json')}`], {cwd:root,stdio:'inherit'});
if(fixtureBuild.error) throw fixtureBuild.error;
if(fixtureBuild.status!==0) process.exit(fixtureBuild.status??1);

await mkdir(candidate, { recursive: true });
await mkdir(candidate, { recursive: true });
await cp(helper, join(candidate, 'helper.mjs'));
const pkg = {name:'@t3-import/t3-v2-native-proof', version:'0.0.0-proof', private:true, type:'module', engines:{node:'>=22.16.0'}, files:['helper.mjs','LICENSES.md','PROVENANCE.json']};
await writeFile(join(candidate,'package.json'), `${JSON.stringify(pkg,null,2)}\n`);
const meta = JSON.parse(await readFile(metafile,'utf8'));
const files = Object.keys(meta.inputs);
const own = files.filter((p)=>p.includes(`/t3code-${commit}/`) && !p.includes('/node_modules/'));
const dependencyPaths = files.filter((p)=>p.includes('/node_modules/.pnpm/'));
const packageRoots = new Map();
for (const input of dependencyPaths) {
  const marker = '/node_modules/.pnpm/'; const i=input.indexOf(marker); const rest=input.slice(i+marker.length);
  const item=rest.split('/node_modules/');
  if(item.length<2) continue;
  let packageName=item[1].split('/')[0];
  if(packageName.startsWith('@')) packageName += '/'+item[1].split('/')[1];
  const rootPath=input.slice(0, i+marker.length)+item[0]+'/node_modules/'+packageName;
  packageRoots.set(rootPath,packageName);
}
const packages=[];
for (const [packageRoot,name] of packageRoots) {
  try {
    const p=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
    const license=p.license ?? 'UNSPECIFIED';
    let licenseText='(No license file found in installed package.)';
    for(const candidateName of ['LICENSE','LICENSE.md','LICENSE.txt','LICENCE','COPYING']) {
      try { licenseText=await readFile(join(packageRoot,candidateName),'utf8'); break; } catch {}
    }
    packages.push({name:p.name??name,version:p.version??'unknown',license,licenseText});
  } catch { packages.push({name,version:'unknown',license:'UNSPECIFIED',licenseText:'(Package metadata not resolved.)'}); }
}
packages.sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version));
const ownLicense = await readFile(join(t3Root,'LICENSE'),'utf8');
const notices = [`# Third-party notices\n\nPinned T3 Code source commit: \`${commit}\` (MIT).\n\n${ownLicense}\n\n## Bundled dependency licenses\n\nThis list is generated from esbuild's traced input closure.\n`];
for(const p of packages) notices.push(`\n### ${p.name}@${p.version} — ${p.license}\n\n${p.licenseText.trim()}\n`);
await writeFile(join(candidate,'LICENSES.md'),notices.join('\n'));
await writeFile(join(root,'scripts/compatibility/v2-native/LICENSES.md'),notices.join('\n'));
const helperBytes=await readFile(join(candidate,'helper.mjs'));
const tarballBytes=await readFile(join(root,'artifacts/t3-reference/release.tar.gz'));
const provenance={t3SourceCommit:commit,t3ReleaseArchiveSha256:createHash('sha256').update(tarballBytes).digest('hex'),bundledHelperSha256:createHash('sha256').update(helperBytes).digest('hex'),esbuildVersion:'0.25.12',nodeTarget:'node22',sourceFiles:own.map((p)=>p.slice(p.indexOf(`/t3code-${commit}/`)+`/t3code-${commit}/`.length)).sort(),bundledDependencyCount:packages.length,bundledDependencyLicenses:packages.map(({name,version,license})=>({name,version,license}))};
await writeFile(join(candidate,'PROVENANCE.json'),`${JSON.stringify(provenance,null,2)}\n`);
await writeFile(join(root,'scripts/compatibility/v2-native/vendor-manifest.json'),`${JSON.stringify(provenance,null,2)}\n`);
const externals=meta.outputs[Object.keys(meta.outputs)[0]].imports.filter((i)=>i.external).map((i)=>i.path);
if(externals.some((p)=>!p.startsWith('node:'))) throw new Error(`Non-builtin runtime external: ${externals.filter((p)=>!p.startsWith('node:')).join(', ')}`);
const pack=spawnSync('npm',['pack','--json','--workspaces=false','--pack-destination',outRoot],{cwd:candidate,encoding:'utf8'});
if(pack.error) throw pack.error;
if(pack.status!==0) { process.stderr.write(pack.stderr); process.exit(pack.status??1); }
const parsedPack=JSON.parse(pack.stdout);
const details=Array.isArray(parsedPack) ? parsedPack[0] : parsedPack[Object.keys(parsedPack)[0]];
const tarball=join(outRoot,details.filename);
const consumer=await mkdtemp(join(outRoot,'clean-consumer-'));
const extract=spawnSync('tar',['-xzf',tarball,'-C',consumer],{stdio:'inherit'}); if(extract.status!==0) process.exit(extract.status??1);
const dbPath=join(consumer,'fixture-home','statev2.sqlite');
const init=spawnSync(process.execPath,[fixture,dbPath],{cwd:consumer,encoding:'utf8'}); if(init.status!==0) {process.stderr.write(init.stderr);process.exit(init.status??1);}
const replay=spawnSync(process.execPath,[join(consumer,'package/helper.mjs'),dbPath],{cwd:consumer,encoding:'utf8',env:{...process.env,NODE_PATH:''}}); if(replay.status!==0) {process.stderr.write(replay.stderr);process.exit(replay.status??1);}
const output=replay.stdout.trim().split('\n').at(-1); const proof=JSON.parse(output); if(proof.result!=='PASS'||!proof.rollback||!proof.closeReopen) throw new Error('Unpacked helper acceptance failed');
console.log(JSON.stringify({candidate,tarball,packBytes:details.size,unpackedBytes:details.unpackedSize,bundledDependencyCount:packages.length,externalRuntimeImports:externals,sourceFileCount:own.length,helperSha256:provenance.bundledHelperSha256,unpackedConsumerRun:proof.result,consumerDirectory:consumer},null,2));
