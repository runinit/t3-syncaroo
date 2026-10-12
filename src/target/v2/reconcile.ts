export interface UpgradeSourceIdentity {
  provider: "codex" | "claude";
  sourceSessionId: string;
  sourceKey: string;
  expectedThreadId: string;
  projectId: string;
}

export interface UpgradeThreadCandidate {
  threadId: string;
  projectId: string;
  historyOrigin?: string;
  /** Result of the shared comparator over all supported canonical history records. */
  historyVerification?: "exact" | "diverged" | "incomplete";
  /** Whether the exact source provider binding is attached to the upgraded shell. */
  nativeBinding?: "absent" | "exact" | "diverged";
}

export interface UpgradeLedgerMapping {
  provider: "codex" | "claude";
  sourceSessionId: string;
  sourceKey: string;
  threadId: string;
  projectId: string;
}

export type UpgradeReconciliation =
  | { status: "absent" }
  | { status: "matched"; threadId: string; recoveredLedger: false }
  | { status: "recoverable"; threadId: string; recoveredLedger: true; action: string }
  | { status: "needs-binding"; threadId: string; recoveredLedger: boolean; action: string }
  | { status: "conflict"; action: string };

/**
 * Match a pre-upgrade import using its stable task identity and project
 * ownership plus the shared semantic comparator's full-history result. Titles
 * and event receipts are excluded because T3 may compact migration events.
 */
export function reconcileUpgradedImport(input: {
  source: UpgradeSourceIdentity;
  candidates: UpgradeThreadCandidate[];
  mapping?: UpgradeLedgerMapping | null;
}): UpgradeReconciliation {
  const { source, candidates, mapping } = input;
  if (mapping) {
    if (mapping.provider !== source.provider || mapping.sourceSessionId !== source.sourceSessionId
      || mapping.sourceKey !== source.sourceKey || mapping.threadId !== source.expectedThreadId
      || mapping.projectId !== source.projectId) {
      return { status: "conflict", action: "Review the saved import mapping and T3 project ownership before syncing or replacing this task." };
    }
  }

  const matchingHistory = candidates.filter((candidate) => candidate.projectId === source.projectId
    && candidate.historyOrigin === "v1_import" && candidate.historyVerification === "exact");
  if (matchingHistory.length > 1) {
    return { status: "conflict", action: "More than one upgraded T3 task has this source history; choose the canonical task before syncing or replacing." };
  }
  const identityCandidate = candidates.find((candidate) => candidate.threadId === (mapping?.threadId ?? source.expectedThreadId));
  if (!identityCandidate) {
    return matchingHistory.length === 1
      ? { status: "conflict", action: "The matching history belongs to a different T3 task ID; verify ownership before recovery." }
      : { status: "absent" };
  }
  if (identityCandidate.projectId !== source.projectId || identityCandidate.historyOrigin !== "v1_import"
    || identityCandidate.historyVerification !== "exact") {
    const detail = identityCandidate.historyVerification === "incomplete"
      ? "The upgraded T3 task has incomplete projected history, so source ownership cannot be proven."
      : "The upgraded T3 task has changed project ownership or transcript history.";
    return { status: "conflict", action: `${detail} Preserve it and resolve the conflict before continuing.` };
  }
  if (identityCandidate.nativeBinding === "diverged") {
    return { status: "conflict", action: "The upgraded T3 task is attached to a different provider session. Preserve it and resolve the binding conflict before continuing." };
  }
  if (identityCandidate.nativeBinding !== "exact") {
    return {
      status: "needs-binding", threadId: identityCandidate.threadId, recoveredLedger: !mapping,
      action: "The upgraded task history is verified, but its native provider binding is missing. Attach it only after validating the original source mapping; continuation and sync must wait until then.",
    };
  }
  return mapping
    ? { status: "matched", threadId: identityCandidate.threadId, recoveredLedger: false }
    : { status: "recoverable", threadId: identityCandidate.threadId, recoveredLedger: true,
      action: "Recreate the external mapping from this verified task; preserve its original backup path as unknown." };
}

export interface UpgradeSequenceEvent {
  sequence: number;
  applicationEventVersion: number;
  aggregateKind: string;
}

export interface UpgradeSequenceEvidence {
  latestV2ThreadSequence: number;
  latestApplicationVersion2Sequence: number;
  latestNativeApplicationSequence: number;
  globalMaximumSequence: number;
  projectionCurrent: boolean;
}

/** Interpret v2's version- and aggregate-scoped cursors in a copied v1 database. */
export function v2UpgradeSequenceEvidence(input: {
  events: UpgradeSequenceEvent[];
  projectionLastSequence: number;
}): UpgradeSequenceEvidence {
  const v2 = input.events.filter((event) => event.applicationEventVersion === 2);
  const max = (events: UpgradeSequenceEvent[]) => events.reduce((latest, event) => Math.max(latest, event.sequence), 0);
  const latestV2ThreadSequence = max(v2.filter((event) => event.aggregateKind === "thread"));
  const latestApplicationVersion2Sequence = max(v2);
  // Pinned EventStoreV2.latestApplicationSequence includes project aggregates
  // regardless of application version, plus v2 thread aggregates.
  const latestNativeApplicationSequence = max(input.events.filter((event) => event.aggregateKind === "project"
    || (event.applicationEventVersion === 2 && event.aggregateKind === "thread")));
  return {
    latestV2ThreadSequence,
    latestApplicationVersion2Sequence,
    latestNativeApplicationSequence,
    globalMaximumSequence: max(input.events),
    // The pinned native thread projection cursor advances with v2 thread events.
    // Project events are included in the broader application high-water mark,
    // but are a different cursor and must not be mixed into this comparison.
    projectionCurrent: input.projectionLastSequence >= latestV2ThreadSequence,
  };
}
