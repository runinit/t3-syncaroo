import { mkdir, realpath, symlink, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

async function resolved(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Point a fixture alias at a dependency tree without rewriting a physical source path onto itself. */
export async function ensureFixtureLink(target, link) {
  const targetPath = resolve(target);
  const linkPath = resolve(link);
  if (targetPath === linkPath) return;

  const [targetParent, linkParent] = await Promise.all([resolved(dirname(targetPath)), resolved(dirname(linkPath))]);
  if (targetParent && targetParent === linkParent && basename(targetPath) === basename(linkPath)) return;

  const canonicalTarget = await resolved(targetPath);
  if (!canonicalTarget) throw new Error(`Fixture dependency target does not exist: ${targetPath}`);
  const canonicalLink = await resolved(linkPath);
  if (canonicalLink === canonicalTarget) return;

  await mkdir(dirname(linkPath), { recursive: true });
  try { await unlink(linkPath); }
  catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
  await symlink(targetPath, linkPath, "dir");
}
