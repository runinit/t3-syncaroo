import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../../..");
const sourceCommit = "d07a07f33c0a1b317dea6234636976231c3688b5";
const t3Root = resolve(projectRoot, `artifacts/t3-reference-2994/t3code-${sourceCommit}`);
const rawBase = `https://raw.githubusercontent.com/pingdotgg/t3code/${sourceCommit}`;
const lockMarker = process.env.T3_V2_PINNED_LOCK_HELD ?? "";
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lockMarker)) {
  if (process.platform !== "linux") throw new Error("Pinned-v2 preparation is Linux-only because the pinned build tools and shared lock use flock.");
  const lockRoot = resolve(projectRoot, "artifacts/v2-native");
  await mkdir(lockRoot, { recursive: true });
  const lockPath = resolve(lockRoot, ".pinned-v2.lock");
  console.log(`Waiting for pinned-v2 preparation lock: ${lockPath}`);
  const locked = spawnSync("flock", ["--exclusive", "--timeout", "2700", lockPath, process.execPath, fileURLToPath(import.meta.url)], {
    cwd: projectRoot,
    env: { ...process.env, T3_V2_PINNED_LOCK_HELD: randomUUID() },
    stdio: "inherit",
  });
  if (locked.error) throw locked.error;
  process.exit(locked.status ?? 1);
}
const sourceLock = JSON.parse(await readFile(resolve(projectRoot, "scripts/compatibility/v2-native/source-lock.json"), "utf8"));
const archivePath = resolve(projectRoot, sourceLock.sourceArchive.path);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function downloadPinnedArchive() {
  try {
    await stat(archivePath);
  } catch {
    await mkdir(dirname(archivePath), { recursive: true });
    const temporaryPath = `${archivePath}.download-${process.pid}`;
    const response = await fetch(`https://github.com/pingdotgg/t3code/archive/${sourceCommit}.tar.gz`);
    if (!response.ok || !response.body) {
      throw new Error(`Pinned T3 archive download failed (${response.status}): ${sourceCommit}`);
    }
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath, { flags: "wx" }));
      const digest = sha256(await readFile(temporaryPath));
      if (digest !== sourceLock.sourceArchive.sha256) {
        throw new Error(`Pinned T3 archive checksum mismatch: expected ${sourceLock.sourceArchive.sha256}, received ${digest}`);
      }
      await rename(temporaryPath, archivePath);
    } catch (error) {
      const { rm } = await import("node:fs/promises");
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  const digest = sha256(await readFile(archivePath));
  if (digest !== sourceLock.sourceArchive.sha256) {
    throw new Error(`Pinned T3 archive checksum mismatch: ${archivePath}`);
  }
}

async function extractPinnedSource() {
  await downloadPinnedArchive();
  try {
    await stat(resolve(t3Root, "pnpm-workspace.yaml"));
    return;
  } catch {
    // A missing checkout is created below from the pinned, checksummed archive.
  }
  try {
    await stat(t3Root);
    throw new Error(`Pinned T3 source directory exists but is incomplete: ${t3Root}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Pinned T3 source directory exists")) throw error;
  }
  await mkdir(t3Root, { recursive: true });
  const extract = spawnSync("tar", ["-xzf", archivePath, "-C", t3Root, "--strip-components=1"], { stdio: "inherit" });
  if (extract.error) throw extract.error;
  if (extract.status !== 0) throw new Error(`Unable to extract pinned T3 source archive (status ${extract.status}).`);
}

async function fetchPinned(relative, destination) {
  const segments = relative.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${rawBase}/${segments}`);
  if (!response.ok) throw new Error(`Pinned source fetch failed (${response.status}): ${relative}`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
}

const workspacePath = resolve(t3Root, "pnpm-workspace.yaml");
await extractPinnedSource();
const workspace = await readFile(workspacePath, "utf8");
const pinnedLockPath = resolve(t3Root, "pnpm-lock.yaml");
const pinnedLockHash = sha256(await readFile(pinnedLockPath));
if (pinnedLockHash !== sourceLock.pnpmLockSha256) {
  throw new Error(`Pinned T3 pnpm-lock.yaml checksum mismatch before install: ${pinnedLockPath}`);
}
const patchPaths = workspace.split("\n")
  .map((line) => line.match(/^\s+[^#].*?:\s+patches\/(.+\.patch)\s*$/)?.[1])
  .filter(Boolean);
for (const patchPath of patchPaths) {
  const destination = resolve(t3Root, "patches", patchPath);
  try {
    await stat(destination);
  } catch {
    await fetchPinned(`patches/${patchPath}`, destination);
  }
}

const localTarball = "apps/mobile/deps/react-native-screens-5.0.0-t3.24.tgz";
try {
  await stat(resolve(t3Root, localTarball));
} catch {
  await fetchPinned(localTarball, resolve(t3Root, localTarball));
}

try {
  await stat(resolve(t3Root, "LICENSE"));
} catch {
  await fetchPinned("LICENSE", resolve(t3Root, "LICENSE"));
}

const install = spawnSync("pnpm", ["install", "--filter", "@t3tools/shared...", "--ignore-scripts", "--frozen-lockfile"], {
  cwd: t3Root,
  env: { ...process.env, CI: process.env.CI ?? "true" },
  stdio: "inherit",
});
if (install.error) throw install.error;
if (install.status !== 0) process.exit(install.status ?? 1);
if (sha256(await readFile(pinnedLockPath)) !== sourceLock.pnpmLockSha256) {
  throw new Error(`Pinned T3 pnpm-lock.yaml changed during install: ${pinnedLockPath}`);
}

console.log(`Prepared pinned T3 source ${sourceCommit}.`);
