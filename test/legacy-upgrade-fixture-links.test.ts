import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureFixtureLink } from "../scripts/compatibility/v2-native/safe-link.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy upgrade fixture dependency links", () => {
  it("leaves an existing dependency link alone when source and dependency roots are aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-fixture-link-alias-"));
    roots.push(root);
    const physical = join(root, "physical");
    const alias = join(root, "alias");
    const effect = join(root, "installed-effect");
    const link = join(physical, "packages/contracts/node_modules/effect");
    await mkdir(join(physical, "packages/contracts/node_modules"), { recursive: true });
    await mkdir(effect, { recursive: true });
    await writeFile(join(effect, "package.json"), "{}\n");
    await symlink(effect, link, "dir");
    await symlink(physical, alias, "dir");
    const before = await readlink(link);

    await ensureFixtureLink(join(alias, "packages/contracts/node_modules/effect"), link);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(before);
    expect(await realpath(link)).toBe(await realpath(effect));
  });

  it("links a source tree to a distinct installed dependency root", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-fixture-link-distinct-"));
    roots.push(root);
    const source = join(root, "source");
    const dependencies = join(root, "dependencies");
    const target = join(dependencies, "packages/contracts/node_modules/effect");
    const link = join(source, "packages/contracts/node_modules/effect");
    await mkdir(target, { recursive: true });
    await mkdir(join(source, "packages/contracts/node_modules"), { recursive: true });
    await writeFile(join(target, "package.json"), "{}\n");

    await ensureFixtureLink(target, link);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await realpath(link)).toBe(await realpath(target));
  });
});
