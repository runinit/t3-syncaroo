import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTargetPaths } from "../src/target/config.js";
import { assertV2Runtime } from "../src/target/schema.js";

const roots: string[] = [];
const home = () => {
  const root = mkdtempSync(join(tmpdir(), "t3-target-selection-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("T3 target selection", () => {
  it("selects statev2.sqlite when both default databases exist", () => {
    const t3Home = home();
    const stateDir = join(t3Home, "userdata");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "state.sqlite"), "legacy fixture");
    writeFileSync(join(stateDir, "statev2.sqlite"), "v2 fixture");

    expect(resolveTargetPaths({ t3Home }).dbPath).toBe(join(stateDir, "statev2.sqlite"));
  });

  it("keeps an explicit database path authoritative", () => {
    const t3Home = home();
    const stateDir = join(t3Home, "userdata");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "statev2.sqlite"), "v2 fixture");
    const explicitDb = join(home(), "custom.sqlite");

    expect(resolveTargetPaths({ t3Home, dbPath: explicitDb }).dbPath).toBe(explicitDb);
  });

  it.each(["22.16.0", "23.11.0", "24.0.0", "26.11.1"])("allows Node %s for the pinned v2 SQLite client", (version) => {
    expect(() => assertV2Runtime(version)).not.toThrow();
  });

  it.each(["22.15.9", "23.10.9", "21.99.0"])("refuses Node %s for the pinned v2 SQLite client", (version) => {
    expect(() => assertV2Runtime(version)).toThrow(`requires Node.js 22.16+, 23.11+, or 24+ (detected ${version})`);
  });
});
