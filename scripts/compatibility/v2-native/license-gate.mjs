import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function readPackageLicenseNotices(packageRoot, packageJson) {
  const name = packageJson.name ?? packageRoot;
  const version = packageJson.version;
  if (!version || packageJson.license == null || packageJson.license === 'UNLICENSED') {
    throw new Error(`Missing version or declared license metadata for bundled dependency ${name}`);
  }
  const entries = await readdir(packageRoot, { withFileTypes: true });
  const licenseFiles = [];
  for (const entry of entries) {
    if (!/^(license|licence|copying|notice)(?:[-_.].*)?$/i.test(entry.name)) continue;
    const licensePath = join(packageRoot, entry.name);
    if (!(await stat(licensePath)).isFile()) continue;
    const text = (await readFile(licensePath, 'utf8')).trim();
    if (text) licenseFiles.push({ file: entry.name, text });
  }
  if (licenseFiles.length === 0) {
    throw new Error(`No bundled license text found for ${name}@${version}; refusing to emit incomplete notices`);
  }
  return licenseFiles;
}

export function assertCompleteLicenseNotices(packages) {
  const missing = packages.filter((pkg) => !pkg.licenseFiles?.length || pkg.licenseFiles.some((license) => !license.text?.trim()));
  if (missing.length > 0) {
    throw new Error(`Incomplete license notices for: ${missing.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')}`);
  }
}
