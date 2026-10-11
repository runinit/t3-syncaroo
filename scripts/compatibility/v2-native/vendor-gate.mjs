import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const vendor = join(root, "vendor");
const manifest = JSON.parse(await readFile(join(root, "scripts/compatibility/v2-native/vendor-manifest.json"), "utf8"));
const provenance = JSON.parse(await readFile(join(vendor, "t3-v2-native-PROVENANCE.json"), "utf8"));
const helper = await readFile(join(vendor, "t3-v2-native-helper.mjs"));
const notices = await readFile(join(vendor, "t3-v2-native-LICENSES.md"), "utf8");
const hash = createHash("sha256").update(helper).digest("hex");

if (JSON.stringify(manifest) !== JSON.stringify(provenance)) {
  throw new Error("Vendored T3 helper provenance does not match the reviewed source manifest.");
}
if (hash !== manifest.bundledHelperSha256) {
  throw new Error(`Vendored T3 helper hash mismatch: expected ${manifest.bundledHelperSha256}, received ${hash}.`);
}
if (manifest.bundledDependencyLicenses.length !== manifest.bundledDependencyCount) {
  throw new Error("Vendored T3 helper license inventory is incomplete.");
}
if (!notices.includes("MIT License") || notices.includes("No license file found")) {
  throw new Error("Vendored T3 helper notices are missing or contain an unresolved license placeholder.");
}

console.log(`Vendored T3 v2 helper verified (${hash}; ${manifest.bundledDependencyCount} dependency notices).`);
