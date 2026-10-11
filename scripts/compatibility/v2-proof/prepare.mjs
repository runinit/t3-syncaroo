import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../../..");
const sourceCommit = "ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e";
const t3Root = resolve(projectRoot, `artifacts/t3-reference/t3code-${sourceCommit}`);
const rawBase = `https://raw.githubusercontent.com/pingdotgg/t3code/${sourceCommit}`;

async function fetchPinned(relative, destination) {
  const segments = relative.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${rawBase}/${segments}`);
  if (!response.ok) throw new Error(`Pinned source fetch failed (${response.status}): ${relative}`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
}

const workspacePath = resolve(t3Root, "pnpm-workspace.yaml");
const workspace = await readFile(workspacePath, "utf8");
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

const localTarball = "apps/mobile/deps/react-native-screens-5.0.0-t3.17.tgz";
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

const install = spawnSync("pnpm", ["install", "--filter", "@t3tools/shared...", "--ignore-scripts"], {
  cwd: t3Root,
  stdio: "inherit",
});
if (install.error) throw install.error;
if (install.status !== 0) process.exit(install.status ?? 1);

console.log(`Prepared pinned T3 source ${sourceCommit}.`);
