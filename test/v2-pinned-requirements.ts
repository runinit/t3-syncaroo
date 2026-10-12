import { existsSync } from "node:fs";
import { basename } from "node:path";

if (process.env.T3_V2_REQUIRED === "1") {
  const sourceDir = process.env.T3_V2_T3_SOURCE_DIR;
  const dependencyRoot = process.env.T3_V2_T3_DEPENDENCY_ROOT;
  const fixtureDb = process.env.T3_V2_FIXTURE_DB;
  const missing = [
    ["T3_V2_T3_SOURCE_DIR", sourceDir],
    ["T3_V2_T3_DEPENDENCY_ROOT", dependencyRoot],
    ["T3_V2_FIXTURE_DB", fixtureDb],
  ].filter(([, value]) => !value || !existsSync(value));
  if (missing.length > 0) {
    throw new Error(`Required pinned-v2 suite inputs are missing: ${missing.map(([name]) => name).join(", ")}`);
  }

  const expectedSource = `t3code-${process.env.T3_V2_SOURCE_COMMIT ?? "d07a07f33c0a1b317dea6234636976231c3688b5"}`;
  if (basename(sourceDir!) !== expectedSource) {
    throw new Error(`Pinned-v2 suite expected source directory ${expectedSource}, got ${basename(sourceDir!)}`);
  }
}
