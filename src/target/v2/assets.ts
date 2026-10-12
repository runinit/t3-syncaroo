import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { TargetPaths } from "../../core/types.js";
import { safetyError } from "../../core/errors.js";
import type { V2HistoryAsset } from "./history.js";

/** Verify source bytes against converted attachment paths and recover missing files only when ownership was proven. */
export function verifyOrRecoverV2Assets(
  plan: { assets: V2HistoryAsset[] },
  paths: TargetPaths,
  ownershipVerified: boolean,
  materialize: (plans: Array<{ assets: V2HistoryAsset[] }>, paths: TargetPaths, runId: string) => { cleanup(): void },
): void {
  const missing: V2HistoryAsset[] = [];
  for (const asset of plan.assets) {
    const expected = asset.data ?? (asset.sourcePath && existsSync(asset.sourcePath) ? readFileSync(asset.sourcePath) : undefined);
    if (!expected) throw safetyError(`The source bytes for ${asset.descriptor.name} are unavailable, so T3 image history cannot be verified. Restore the source attachment before retrying.`);
    if (!existsSync(asset.finalPath)) {
      missing.push(asset);
      continue;
    }
    const current = readFileSync(asset.finalPath);
    if (!current.equals(expected)) throw safetyError(`The existing T3 image for ${asset.descriptor.name} does not match the source session. Preserve it and resolve the attachment conflict before retrying.`);
  }
  if (missing.length === 0) return;
  if (!ownershipVerified) throw safetyError("T3 has imported image references but the attachment bytes are missing and no matching import checkpoint proves their contents. Restore the verified backup or resolve the attachment conflict before retrying.");
  const staged = materialize([{ assets: missing }], paths, randomUUID());
  staged.cleanup();
}
