import type { OperationOutcomeCounts, SessionOutcomeRecord } from "./types.js";

/** Count every classified session once; provider-wide diagnostics are tracked separately. */
export function summarizeOutcomeCounts(
  items: Array<{ status: string }>,
  outcomes: SessionOutcomeRecord[],
  diagnostics: SessionOutcomeRecord[],
): OperationOutcomeCounts {
  const counts: OperationOutcomeCounts = {
    success: 0,
    imported: 0,
    synced: 0,
    replaced: 0,
    planned: 0,
    alreadyImported: 0,
    deferred: 0,
    conflict: 0,
    unsupported: 0,
    failed: 0,
    scanDiagnostics: diagnostics.length,
    classified: items.length + outcomes.length,
  };
  for (const { status } of items) {
    if (status === "imported") counts.imported += 1;
    else if (status === "synced") counts.synced += 1;
    else if (status === "replaced") counts.replaced += 1;
    else if (status === "dry-run") counts.planned += 1;
    else if (["already-imported", "up-to-date", "already-current"].includes(status)) counts.alreadyImported += 1;
    else if (status === "not-imported") counts.deferred += 1;
    else if (["branch-sync-unsupported", "branch-replace-unsupported"].includes(status)) counts.unsupported += 1;
    else if (["history-diverged", "active-source"].includes(status)) counts.conflict += 1;
    else counts.failed += 1;
  }
  for (const { outcome } of outcomes) {
    if (outcome.kind === "success") counts.success += 1;
    else if (outcome.kind === "already-imported" || outcome.kind === "adopted") counts.alreadyImported += 1;
    else counts[outcome.kind] += 1;
  }
  return counts;
}
