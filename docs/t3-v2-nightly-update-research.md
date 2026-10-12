# T3 Code nightly update: 2980 to 2994

Comparison target: installed `0.0.46-nightly.20261011.2994`, resolved from the
upstream tag to commit
[`d07a07f33c0a1b317dea6234636976231c3688b5`](https://github.com/pingdotgg/t3code/commit/d07a07f33c0a1b317dea6234636976231c3688b5).
Baseline is `0.0.46-nightly.20261011.2980`, commit
[`ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e`](https://github.com/pingdotgg/t3code/commit/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e).
This is a bounded source comparison to update the earlier
[t3-v2 support research](t3-v2-support-research.md). The user has now approved
`.2994` as the implementation target. The earlier `.2980` proof remains
historical evidence and is not runtime or GUI acceptance for `.2994`.

## Verdict

At source level, 2994 preserves the v2 persistence and event-writing contract
examined for 2980: the comparison contains no changes to `EventSinkV2`, event
store, projection store/maintenance, persistence migrations, v2 contracts,
provider adapters, or built-in session importer/scanner. The native write path
and schema findings in the earlier report therefore remain applicable to 2994.
This is a source-diff conclusion, not a runtime compatibility test.

The update does matter to any implementation that invokes T3's thread-management
or provider orchestration layers: 2994 adds provider enablement checks to launch,
message dispatch, queue continuation, and adapter wake handling. An isolated
native EventSink adapter does not appear to cross those changed service paths;
a helper based on `ThreadManagementService` or orchestration must include the
new settings and command-receipt dependencies and handle the new disabled error.
Re-review the selected integration seam against 2994 before coding.

## Verified source comparison

- The tag resolves to the commit above. The upstream
  [2980-to-2994 source comparison](https://github.com/pingdotgg/t3code/compare/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e...d07a07f33c0a1b317dea6234636976231c3688b5)
  lists the changed files and patch. No path in the diff is under
  `apps/server/src/persistence/`; none is `EventSink.ts`, `EventStore.ts`,
  `ProjectionStore.ts`, or `ProjectionMaintenance.ts`; and none is
  `AgentSessionImporter.ts`, `AgentSessionScanner.ts`, `ClaudeAdapterV2.ts`,
  `CodexAdapterV2.ts`, `packages/contracts/src/orchestrationV2.ts`, or
  `chatAttachment.ts`. This establishes unchanged source text for those paths
  between the two pins, not successful execution against either binary.
- The 2994 [EventSink implementation](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/apps/server/src/orchestration-v2/EventSink.ts)
  remains the same pinned native-writer code relied on in the previous report.
  Migration files likewise do not occur in the comparison's changed-file list;
  consequently this patch adds no migration/schema change. This does not prove
  which T3 binary created an arbitrary database or guarantee future nightly
  compatibility.
- `ThreadManagementService` now validates provider enablement before dispatching
  `message.dispatch` and `delegated_task.request`; a command with an existing
  receipt remains eligible for receipt replay. See the new
  [`assertProviderInstanceEnabled` and dispatch gate](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/apps/server/src/orchestration-v2/ThreadManagementService.ts#L523-L656).
  Launch also checks the selected instance ([`ThreadLaunchService.ts`](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/apps/server/src/orchestration-v2/ThreadLaunchService.ts#L772-L779)).
- Orchestration avoids starting a queued run after its instance becomes disabled
  ([`Orchestrator.ts`](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/apps/server/src/orchestration-v2/Orchestrator.ts#L1321-L1350)).
  Continuation handling catches disabled-instance errors, clears buffered wakes,
  and acknowledges delegated deliveries instead of retrying them
  ([`ProviderContinuationService.ts`](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/apps/server/src/orchestration-v2/ProviderContinuationService.ts#L126-L200),
  [wake cleanup](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/apps/server/src/orchestration-v2/ProviderContinuationService.ts#L229-L264)).
- The service's new implementation depends on `ServerSettingsService` and
  `CommandReceiptStoreV2` and exposes a new tagged disabled-instance error
  ([service layer requirements](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/apps/server/src/orchestration-v2/ThreadManagementService.ts#L273-L294),
  [layer composition](https://github.com/pingdotgg/t3code/blob/d07a07f33c0a1b317dea6234636976231c3688b5/apps/server/src/orchestration-v2/ThreadManagementService.ts#L1175-L1192)).
  Any copied helper that uses this service must update its layer wiring and
  error handling. Direct EventSink-only writes do not use this service by
  definition, but a runtime harness must prove the actual composition.
- Other relevant changes include project-aware source-control model selection,
  deleting project-specific provider settings with a project, and web UI/runtime
  handling. These do not alter the native event schemas. The comparison is broad
  (364 changed paths, most in mobile/UI); review the integration surface rather
  than treating every nightly delta as an importer change.

## Implementation implications and proof still needed

**Implementation direction:** use the `.2994` source commit above as the
implementation baseline while retaining the `.2980` EventSink/schema findings
only where the source comparison confirms they remain unchanged. Keep provider
continuation testing separate from transcript projection testing. For any helper
using thread management, provide settings and receipt-store layers and test both enabled and
disabled instances, including receipt replay and queued continuation. Keep
T3's provider enablement semantics intact; importing settled history should not
silently launch a provider turn.

**Not verified at runtime:** no native append, projection readback, provider
continuation, migration run, UI rendering, or packaging test was executed on
2994. No installed user database/cache was accessed and no provider was called.
The smallest useful next proof is an isolated 2994 source harness using a fresh
temporary database: initialize/migrate, write one settled synthetic thread via
the pinned EventSink, read its history through the native projection API, then
repeat to exercise importer-level idempotence and rollback. Separately exercise
`ThreadManagementService` with provider enabled/disabled and receipt/no-receipt
cases. Do not infer those outcomes from this source comparison.
