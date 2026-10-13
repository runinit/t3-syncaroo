package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/CarlosGtrz/t3-import/internal/checkpoint"
	"github.com/CarlosGtrz/t3-import/internal/domain"
	"github.com/CarlosGtrz/t3-import/internal/identity"
	"github.com/CarlosGtrz/t3-import/internal/target/assets"
	"github.com/CarlosGtrz/t3-import/internal/target/backup"
	"github.com/CarlosGtrz/t3-import/internal/target/cache"
	"github.com/CarlosGtrz/t3-import/internal/target/ledger"
	"github.com/CarlosGtrz/t3-import/internal/target/legacy"
	"github.com/CarlosGtrz/t3-import/internal/target/lock"
	targetruntime "github.com/CarlosGtrz/t3-import/internal/target/runtime"
	"github.com/CarlosGtrz/t3-import/internal/target/schema"
	"github.com/CarlosGtrz/t3-import/internal/target/sqlite"
	"github.com/CarlosGtrz/t3-import/internal/target/v2"
)

type workflowResult struct {
	Imported    *domain.ImportRunResult       `json:"imported,omitempty"`
	Synced      *domain.SyncRunResult         `json:"synced,omitempty"`
	Replaced    *domain.ReplaceRunResult      `json:"replaced,omitempty"`
	Outcomes    []domain.SessionOutcomeRecord `json:"outcomes"`
	Diagnostics []domain.SessionOutcomeRecord `json:"diagnostics"`
}

type preparedSession struct {
	loaded     loadedSession
	assessment sessionAssessment
	operation  string
}

func (s *Service) execute(ctx context.Context, request Request) (any, error) {
	if !request.Source.Valid() {
		return nil, errors.New("source is required")
	}
	if request.Workspace == "" {
		return nil, errors.New("workspace is required")
	}
	if !request.All && len(request.SessionIDs) == 0 {
		return nil, errors.New("select at least one conversation")
	}
	if _, err := targetruntime.AssertT3Closed(ctx, s.Paths); err != nil {
		return nil, withExitCode(4, err)
	}
	adapter, err := s.Sources.Get(request.Source)
	if err != nil {
		return nil, withExitCode(2, err)
	}
	discovery, err := discoveryOptions(request)
	if err != nil {
		return nil, err
	}
	discovery.Workspace = &request.Workspace
	found, err := adapter.DiscoverWithOutcomes(ctx, discovery)
	if err != nil {
		return nil, withExitCode(5, err)
	}
	wanted := map[string]bool{}
	for _, id := range request.SessionIDs {
		wanted[id] = true
	}
	summaries := make([]domain.SourceSummary, 0)
	if request.All {
		summaries = append(summaries, found.Summaries...)
	} else {
		byID := make(map[string]domain.SourceSummary, len(found.Summaries))
		for _, summary := range found.Summaries {
			byID[summary.ID] = summary
		}
		for _, id := range sortedIDs(request.SessionIDs) {
			if _, ok := byID[id]; !ok {
				return nil, withExitCode(5, fmt.Errorf("selected source session disappeared before execution: %s", id))
			}
			summaries = append(summaries, byID[id])
		}
	}
	outcomes := selectedOutcomes(found.Outcomes, wanted, request.All)
	if len(summaries) == 0 {
		return workflowResult{Outcomes: outcomes, Diagnostics: providerDiagnostics(found.Outcomes)}, nil
	}
	loaded := make([]loadedSession, 0, len(summaries))
	for _, summary := range summaries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		conversation, loadErr := adapter.Load(ctx, summary, discovery)
		if loadErr != nil {
			outcomes = append(outcomes, loadFailure(summary))
			continue
		}
		loaded = append(loaded, loadedSession{summary: conversation.Summary, conversation: conversation})
	}
	if _, err := targetruntime.AssertT3Closed(ctx, s.Paths); err != nil {
		return nil, withExitCode(4, err)
	}
	db, info, err := openValidatedTarget(ctx, s.Paths, true)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	records, err := s.targetRecords(ctx, request.Source)
	if err != nil {
		return nil, err
	}
	prepared := make([]preparedSession, 0, len(loaded))
	for _, session := range loaded {
		assessment, assessErr := s.assess(ctx, db, info, records, session.conversation, request.Mode, request.Provider, request.NoResume)
		if assessErr != nil {
			outcomes = append(outcomes, loadFailure(session.summary))
			continue
		}
		operation, classifyErr := classifyOperation(assessment.preview, request.Mode)
		if classifyErr != nil {
			return nil, classifyErr
		}
		prepared = append(prepared, preparedSession{loaded: session, assessment: assessment, operation: operation})
	}
	if len(prepared) == 0 {
		return workflowResult{Outcomes: outcomes, Diagnostics: providerDiagnostics(found.Outcomes)}, nil
	}
	operations := operationGroups(prepared)
	if len(operations["replace"]) > 0 && (len(operations["import"]) > 0 || len(operations["sync"]) > 0) {
		return nil, withExitCode(2, errors.New("replacement cannot be mixed with import or synchronization selections"))
	}
	if request.DryRun {
		return s.runDryRun(ctx, request, info, prepared, outcomes, found.Outcomes)
	}
	if _, err := targetruntime.AssertT3Closed(ctx, s.Paths); err != nil {
		return nil, withExitCode(4, err)
	}
	result := workflowResult{Outcomes: outcomes, Diagnostics: providerDiagnostics(found.Outcomes)}
	if len(operations["import"]) > 0 {
		imported, err := s.writeImports(ctx, request, info, operations["import"])
		if err != nil {
			return nil, err
		}
		result.Imported = imported
	}
	if len(operations["sync"]) > 0 {
		synced, err := s.writeSyncs(ctx, request, info, operations["sync"], len(operations["import"]) > 0)
		if err != nil {
			return nil, err
		}
		result.Synced = synced
	}
	if len(operations["replace"]) > 0 {
		replaced, err := s.writeReplacements(ctx, request, info, operations["replace"])
		if err != nil {
			return nil, err
		}
		result.Replaced = replaced
	}
	allOutcomes := append([]domain.SessionOutcomeRecord{}, result.Outcomes...)
	for _, operation := range []any{result.Imported, result.Synced, result.Replaced} {
		switch value := operation.(type) {
		case *domain.ImportRunResult:
			if value != nil {
				value.Outcomes, value.Diagnostics = &allOutcomes, &result.Diagnostics
			}
		case *domain.SyncRunResult:
			if value != nil {
				value.Outcomes, value.Diagnostics = &allOutcomes, &result.Diagnostics
			}
		case *domain.ReplaceRunResult:
			if value != nil {
				value.Outcomes, value.Diagnostics = &allOutcomes, &result.Diagnostics
			}
		}
	}
	return result, nil
}

func selectedOutcomes(items []domain.SessionOutcomeRecord, wanted map[string]bool, all bool) []domain.SessionOutcomeRecord {
	var selected []domain.SessionOutcomeRecord
	for _, item := range items {
		if item.SessionID == nil || all || wanted[*item.SessionID] {
			selected = append(selected, item)
		}
	}
	return selected
}

func providerDiagnostics(items []domain.SessionOutcomeRecord) []domain.SessionOutcomeRecord {
	var diagnostics []domain.SessionOutcomeRecord
	for _, item := range items {
		if item.SessionID == nil {
			diagnostics = append(diagnostics, item)
		}
	}
	return diagnostics
}

func classifyOperation(preview PreviewSession, mode Mode) (string, error) {
	if preview.Outcome != nil {
		return "", withExitCode(7, errors.New("one or more selected conversations could not be loaded; return to the list and review the updated statuses"))
	}
	if mode == ModeReplace {
		if preview.Replacement.Selectable {
			return "replace", nil
		}
	} else if mode == ModeSync {
		if preview.Sync.Status == "syncable" {
			return "sync", nil
		}
	} else {
		if preview.Sync.Status == "history-diverged" && preview.Replacement.Selectable {
			return "replace", nil
		}
		if preview.Sync.Status == "new" {
			return "import", nil
		}
		if preview.Sync.Status == "syncable" {
			return "sync", nil
		}
	}
	return "", withExitCode(7, fmt.Errorf("selected conversation %q is no longer eligible; return to the list and review the updated statuses", preview.Summary.ID))
}

func operationGroups(sessions []preparedSession) map[string][]preparedSession {
	groups := map[string][]preparedSession{"import": {}, "sync": {}, "replace": {}}
	for _, session := range sessions {
		if session.operation == "replace" {
			groups["replace"] = append(groups["replace"], session)
			continue
		}
		hasImport, hasSync := false, false
		for _, plan := range session.assessment.threadPlans {
			hasImport = hasImport || plan.status == "new"
			hasSync = hasSync || plan.status == "syncable"
		}
		if hasImport {
			groups["import"] = append(groups["import"], session)
		}
		if hasSync {
			groups["sync"] = append(groups["sync"], session)
		}
	}
	return groups
}

func (s *Service) runDryRun(ctx context.Context, request Request, info schema.Info, sessions []preparedSession, outcomes []domain.SessionOutcomeRecord, discovered []domain.SessionOutcomeRecord) (any, error) {
	result := workflowResult{Outcomes: outcomes, Diagnostics: providerDiagnostics(discovered)}
	groups := operationGroups(sessions)
	for _, operation := range []string{"import", "sync", "replace"} {
		group := groups[operation]
		if len(group) == 0 {
			continue
		}
		switch operation {
		case "import":
			value, err := s.planImports(ctx, request, info, group, true)
			if err != nil {
				return nil, err
			}
			result.Imported = value
		case "sync":
			value, err := s.planSyncs(ctx, request, info, group, true)
			if err != nil {
				return nil, err
			}
			result.Synced = value
		case "replace":
			value, err := s.planReplacements(ctx, request, info, group, true)
			if err != nil {
				return nil, err
			}
			result.Replaced = value
		}
	}
	return result, nil
}

func (s *Service) writeImports(ctx context.Context, request Request, info schema.Info, sessions []preparedSession) (*domain.ImportRunResult, error) {
	result, err := s.runTargetWrite(ctx, "import", request, func(ctx context.Context, db *sql.DB, backupPath string) (any, bool, error) {
		return s.executeImportPlans(ctx, db, info, backupPath, request, sessions)
	})
	if err != nil {
		return nil, err
	}
	value, ok := result.(*domain.ImportRunResult)
	if !ok {
		return nil, errors.New("import workflow returned an invalid result")
	}
	return value, nil
}

func (s *Service) writeSyncs(ctx context.Context, request Request, info schema.Info, sessions []preparedSession, allowBacklog bool) (*domain.SyncRunResult, error) {
	value, err := s.runTargetWrite(ctx, "sync", request, func(ctx context.Context, db *sql.DB, backupPath string) (any, bool, error) {
		return s.executeSyncPlans(ctx, db, info, backupPath, request, sessions, allowBacklog)
	})
	if err != nil {
		return nil, err
	}
	result, ok := value.(*domain.SyncRunResult)
	if !ok {
		return nil, errors.New("sync workflow returned an invalid result")
	}
	return result, nil
}

func (s *Service) writeReplacements(ctx context.Context, request Request, info schema.Info, sessions []preparedSession) (*domain.ReplaceRunResult, error) {
	value, err := s.runTargetWrite(ctx, "replacement", request, func(ctx context.Context, db *sql.DB, backupPath string) (any, bool, error) {
		return s.executeReplacementPlans(ctx, db, info, backupPath, request, sessions)
	})
	if err != nil {
		return nil, err
	}
	result, ok := value.(*domain.ReplaceRunResult)
	if !ok {
		return nil, errors.New("replacement workflow returned an invalid result")
	}
	return result, nil
}

func (s *Service) planSyncs(ctx context.Context, request Request, info schema.Info, sessions []preparedSession, dryRun bool) (*domain.SyncRunResult, error) {
	db, _, err := openValidatedTarget(ctx, s.Paths, true)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	items, _, warnings, err := s.buildSyncPlans(ctx, db, info, sessions, request)
	if err != nil {
		return nil, err
	}
	results := make([]domain.SyncItemResult, 0, len(items))
	changed := false
	for _, item := range items {
		status := domain.SyncDryRun
		result := syncItem{item}.result(status)
		if item.events == 0 && item.adopted == 0 && result.TurnsAdded == 0 {
			status = domain.SyncUpToDate
		} else {
			changed = true
		}
		results = append(results, syncItem{item}.result(status))
	}
	_ = dryRun
	status := domain.SyncRunUpToDate
	if changed {
		status = domain.SyncRunDryRun
	}
	return &domain.SyncRunResult{SchemaVersion: 1, Status: status, Target: s.Paths.DBPath, Migration: info.Migration, Results: results, Warnings: warnings}, nil
}

func (s *Service) planReplacements(ctx context.Context, request Request, info schema.Info, sessions []preparedSession, dryRun bool) (*domain.ReplaceRunResult, error) {
	db, _, err := openValidatedTarget(ctx, s.Paths, true)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	items, warnings, err := s.buildReplacementPlans(ctx, db, info, sessions, request)
	if err != nil {
		return nil, err
	}
	results := make([]domain.ReplaceItemResult, 0, len(items))
	for _, item := range items {
		results = append(results, replacementItem{item}.result(domain.ReplaceDryRun))
	}
	_ = dryRun
	status := domain.ReplaceRunDryRun
	return &domain.ReplaceRunResult{SchemaVersion: 1, Status: status, Target: s.Paths.DBPath, Migration: info.Migration, Results: results, Warnings: warnings}, nil
}

type syncPlan struct {
	session            preparedSession
	planned            plannedThread
	record             ledger.Record
	recovered          bool
	recoveryOldRecords []ledger.Record
	legacySaved        checkpoint.CheckpointV2
	legacyLast         int64
	v2Plan             v2.SyncPlan
	events             int
	adopted            int
	nativeVerified     bool
	titleAction        domain.SyncTitleAction
}
type replacementPlan struct {
	session       preparedSession
	planned       plannedThread
	old           []ledger.Record
	legacyDeletes []legacy.Event
	v2Plan        v2.ReplacementPlan
	events        int
	oldIDs        []string
}
type syncItem struct{ plan syncPlan }

func (i syncItem) result(status domain.SyncItemStatus) domain.SyncItemResult {
	p := i.plan
	t := p.planned.thread
	id, project := p.record.ThreadID, p.record.ProjectID
	turns := 0
	for _, turn := range t.Turns {
		if turn.Status.Terminal() {
			turns++
		}
	}
	added := max(0, turns-checkpointCount(p.record.Checkpoint)-p.adopted)
	return domain.SyncItemResult{Source: t.Source, SourceID: t.SourceSessionID, SourceKey: t.SourceKey, Status: status, ThreadID: &id, ProjectID: &project, Title: t.Title, TurnsAdded: added, TurnsAdopted: p.adopted, Events: p.events, Attachments: len(p.planned.v2Plan.Assets) + len(p.planned.legacyPlan.Assets), TitleAction: p.titleAction, Resumable: p.record.Resumable, Warnings: planWarnings(p.planned)}
}

type replacementItem struct{ plan replacementPlan }

func (i replacementItem) result(status domain.ReplaceItemStatus) domain.ReplaceItemResult {
	p := i.plan
	t := p.planned.thread
	ids := append([]string(nil), p.oldIDs...)
	oldID := ""
	if len(ids) > 0 {
		oldID = ids[0]
	}
	newID := p.planned.threadID
	project := p.planned.projectID
	return domain.ReplaceItemResult{Source: t.Source, SourceID: t.SourceSessionID, SourceKey: t.SourceKey, Status: status, OldThreadID: &oldID, NewThreadID: &newID, ProjectID: &project, Title: t.Title, Turns: len(t.Turns), Events: p.events, Attachments: len(p.planned.v2Plan.Assets) + len(p.planned.legacyPlan.Assets), ResumeTransferred: p.planned.resumable, OldThreadIDs: &ids, Warnings: planWarnings(p.planned)}
}

func (s *Service) buildSyncPlans(ctx context.Context, db *sql.DB, info schema.Info, sessions []preparedSession, request Request) ([]syncPlan, []domain.SyncItemResult, []string, error) {
	var plans []syncPlan
	var results []domain.SyncItemResult
	var warnings []string
	totalEvents := 0
	for _, session := range sessions {
		for _, state := range session.assessment.threadPlans {
			if state.status != "syncable" {
				continue
			}
			record, ok := uniqueCanonicalRecord(state.oldRecords)
			if !ok {
				return nil, nil, nil, fmt.Errorf("sync mapping for %s is missing or ambiguous", state.thread.SourceKey)
			}
			thread := terminalThread(state.thread)
			full, err := s.planThread(ctx, info, db, thread, request.Provider, record.ProjectID, false, request.NoResume)
			if err != nil {
				return nil, nil, nil, err
			}
			full.threadID = record.ThreadID
			full.projectID = record.ProjectID
			full.fingerprint = session.loaded.conversation.Fingerprint
			full.resumable = record.Resumable
			full.upgraded = state.upgraded
			full.recoveryOldRecords = append([]ledger.Record(nil), state.recoveryOldRecords...)
			if info.Profile == schema.ProfileLegacy {
				if record.IdentitySeed != "" {
					full.legacyPlan.Target.IdentitySeed = record.IdentitySeed
				}
			} else {
				full.v2Plan, err = v2PlanForRecord(thread, record, full.provider, s.Paths.AttachmentsDir)
				if err != nil {
					return nil, nil, nil, err
				}
			}
			plan := syncPlan{session: session, planned: full, record: record, recovered: state.recovered, recoveryOldRecords: append([]ledger.Record(nil), full.recoveryOldRecords...), titleAction: domain.TitleUnchanged}
			if state.recovered {
				warnings = append(warnings, fmt.Sprintf("Recovered a verified import ledger mapping for %s without replaying its T3 history.", thread.SourceSessionID))
			}
			if info.Profile == schema.ProfileLegacy {
				var saved checkpoint.CheckpointV2
				last := record.LastSequence
				if len(record.Checkpoint) == 0 {
					target := full.legacyPlan.Target
					saved, last, err = legacy.BootstrapCheckpoint(ctx, db, thread, target)
					if err != nil {
						return nil, nil, nil, err
					}
				} else if stored, valid := checkpoint.Parse(string(record.Checkpoint)); !valid {
					return nil, nil, nil, fmt.Errorf("sync checkpoint for %s is invalid", record.ThreadID)
				} else if stored.Version == 2 {
					saved = *stored.V2
				} else {
					current, e := checkpoint.ForThread(thread)
					if e != nil {
						return nil, nil, nil, e
					}
					n := len(stored.V1.Turns)
					if n > len(current.Turns) {
						return nil, nil, nil, errors.New("legacy checkpoint is longer than source history")
					}
					saved = checkpoint.CheckpointV2{Version: 2, Turns: append([]checkpoint.TurnV2(nil), current.Turns[:n]...)}
				}
				plan.legacySaved = saved
				plan.legacyLast = last
				provider := full.legacyPlan.Provider
				titleEvent, titleChanged, e := legacy.PlanTitleUpdate(ctx, db, thread, full.legacyPlan.Target, record.SourceTitle, provider)
				if e != nil {
					return nil, nil, nil, e
				}
				if titleChanged {
					plan.titleAction = domain.TitleUpdated
					_ = titleEvent
				} else if thread.Title != record.SourceTitle {
					plan.titleAction = domain.TitlePreservedLocal
				}
				if len(thread.Turns) > len(saved.Turns) {
					suffix := thread
					suffix.Turns = append([]domain.CanonicalTurn(nil), thread.Turns[len(saved.Turns):]...)
					appendPlan := legacy.PlanImport(suffix, full.legacyPlan.Target, full.legacyPlan.Provider, full.resumable)
					plan.events = len(appendPlan.Events)
				}
				if plan.titleAction == domain.TitleUpdated {
					plan.events++
				}
			} else {
				existing, e := v2.InspectThread(ctx, db, record.ThreadID)
				if e != nil {
					return nil, nil, nil, e
				}
				full.v2Plan.ThreadID = record.ThreadID
				full.v2Plan.ProjectID = record.ProjectID
				var syncPlan v2.SyncPlan
				if full.upgraded {
					upgradedRecord, match, proofErr := s.recoverUpgradedV2Import(ctx, db, info, full, &record, session.loaded.conversation.Fingerprint)
					if proofErr != nil {
						return nil, nil, nil, fmt.Errorf("upgraded sync verification for %s failed: %w", thread.SourceSessionID, proofErr)
					}
					events := make([]v2.Event, 0, len(thread.Turns)-match.PrefixTurns+1)
					if match.ProviderEvent != nil {
						events = append(events, *match.ProviderEvent)
					}
					suffixEvents, eventsErr := v2.NativeSyncEvents(thread, upgradedRecord.IdentitySeed, full.v2Plan, match.PrefixTurns, s.Paths.AttachmentsDir)
					if eventsErr != nil {
						return nil, nil, nil, eventsErr
					}
					events = append(events, suffixEvents...)
					plan.record = upgradedRecord
					syncPlan = v2.SyncPlan{ThreadID: record.ThreadID, ProjectID: record.ProjectID, ProviderInstanceID: full.provider.InstanceID, Expected: existing, Events: events, Runtime: full.v2Plan.Runtime}
				} else {
					saved, hasNativeCheckpoint := checkpoint.Parse(string(record.Checkpoint))
					if hasNativeCheckpoint && saved.Version == 2 && saved.V2.NativeProjection != nil {
						match, matchErr := v2.VerifyNativeSync(ctx, db, thread, record.IdentitySeed, full.v2Plan, saved, s.Paths.AttachmentsDir)
						if matchErr != nil {
							return nil, nil, nil, fmt.Errorf("native sync verification for %s failed: %w", thread.SourceSessionID, matchErr)
						}
						events, eventsErr := v2.NativeSyncEvents(thread, record.IdentitySeed, full.v2Plan, match.AppendFrom, s.Paths.AttachmentsDir)
						if eventsErr != nil {
							return nil, nil, nil, eventsErr
						}
						if len(match.SupplementalEvents) > 0 {
							events = append(append([]v2.Event(nil), match.SupplementalEvents...), events...)
						}
						if len(events) > 0 {
							if err = v2.AssignAppendOrdinals(ctx, db, record.ThreadID, events); err != nil {
								return nil, nil, nil, err
							}
						}
						syncPlan = v2.SyncPlan{ThreadID: record.ThreadID, ProjectID: record.ProjectID, ProviderInstanceID: full.provider.InstanceID, Expected: existing, Events: events, Runtime: full.v2Plan.Runtime}
						plan.adopted = match.AdoptedTurns
						plan.nativeVerified = true
					} else {
						syncPlan, e = v2.BuildSyncPlan(existing, full.v2Plan)
						if e != nil {
							return nil, nil, nil, e
						}
					}
				}
				plan.v2Plan = syncPlan
				plan.events = len(syncPlan.Events)
				if len(syncPlan.Events) > 0 {
					plan.titleAction = domain.TitleUpdated
				}
			}
			if plan.events > maxSafeEvents {
				return nil, nil, nil, withExitCode(4, fmt.Errorf("sync would append %d events, exceeding the safe one-launch limit", plan.events))
			}
			totalEvents += plan.events
			if totalEvents > maxSafeEvents {
				return nil, nil, nil, withExitCode(4, fmt.Errorf("sync batch would append %d events, exceeding the safe one-launch limit of %d", totalEvents, maxSafeEvents))
			}
			plans = append(plans, plan)
			results = append(results, syncItem{plan}.result(domain.SyncDryRun))
			warnings = append(warnings, planWarnings(full)...)
		}
	}
	return plans, results, warnings, nil
}

func uniqueCanonicalRecord(records []ledger.Record) (ledger.Record, bool) {
	var found []ledger.Record
	seen := map[string]bool{}
	for _, r := range records {
		if (r.IsCanonical == nil || *r.IsCanonical) && !seen[r.ThreadID] {
			found = append(found, r)
			seen[r.ThreadID] = true
		}
	}
	if len(found) != 1 {
		return ledger.Record{}, false
	}
	return found[0], true
}

func (s *Service) executeSyncPlans(ctx context.Context, db *sql.DB, info schema.Info, backupPath string, request Request, sessions []preparedSession, allowBacklog bool) (any, bool, error) {
	plans, _, warnings, err := s.buildSyncPlans(ctx, db, info, sessions, request)
	if err != nil {
		return nil, false, err
	}
	if len(plans) == 0 {
		return &domain.SyncRunResult{SchemaVersion: 1, Status: domain.SyncRunUpToDate, Target: s.Paths.DBPath, Migration: info.Migration, Results: []domain.SyncItemResult{}, Warnings: warnings}, false, nil
	}
	for _, p := range plans {
		if p.events > 0 {
			count := p.events
			if count > maxSafeEvents {
				return nil, false, withExitCode(4, errors.New("sync exceeds the safe event limit"))
			}
			_ = count
		}
	}
	allAssets := []assets.Asset{}
	for _, p := range plans {
		allAssets = append(allAssets, p.planned.v2Plan.Assets...)
		allAssets = append(allAssets, p.planned.legacyPlan.Assets...)
	}
	_, rollbackAssets, err := assets.Materialize(s.Paths.AttachmentsDir, allAssets)
	if err != nil {
		return nil, false, err
	}
	store, err := openLedgerStore()
	if err != nil {
		rollbackAssets()
		return nil, false, err
	}
	rows := []ledger.Record{}
	consolidations := []ledger.Consolidation{}
	results := []domain.SyncItemResult{}
	changed := false
	ledgerRecovered := false
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, p := range plans {
		r := p.record
		first, last := int64(0), int64(0)
		added, adopted := 0, 0
		if info.Profile == schema.ProfileLegacy {
			result, e := legacy.SyncAppend(ctx, db, p.planned.thread, p.planned.legacyPlan.Target, p.planned.legacyPlan.Provider, p.legacySaved, p.legacyLast, r.Resumable)
			if e != nil {
				err = e
				break
			}
			added, adopted = result.TurnsAdded, result.TurnsAdopted
			first, last = result.FirstSequence, result.LastSequence
			if p.titleAction == domain.TitleUpdated {
				event, yes, e := legacy.PlanTitleUpdate(ctx, db, p.planned.thread, p.planned.legacyPlan.Target, r.SourceTitle, p.planned.legacyPlan.Provider)
				if e != nil {
					err = e
					break
				}
				if yes {
					a, b, e := legacy.Append(ctx, db, []legacy.Event{event})
					if e != nil {
						err = e
						break
					}
					if first == 0 || a < first {
						first = a
					}
					if b > last {
						last = b
					}
				}
			}
		} else {
			stored, e := v2.AppendSync(ctx, db, p.v2Plan)
			if e != nil {
				err = e
				break
			}
			adopted = p.adopted
			added = max(0, len(p.planned.thread.Turns)-checkpointCount(r.Checkpoint)-adopted)
			if len(stored) > 0 {
				first = stored[0].Sequence
				last = stored[len(stored)-1].Sequence
			}
		}
		if first == 0 && last == 0 {
			last, err = lastThreadSequence(ctx, db, r.ThreadID)
			if err != nil {
				break
			}
		}
		cp, e := checkpoint.ForThread(p.planned.thread)
		if e != nil {
			err = e
			break
		}
		if info.Profile == schema.ProfileV2 {
			// Every successful v2 sync leaves a verified identity anchor for the
			// complete projected history. This also repairs a stale ledger after
			// T3 committed the source suffix but the prior process stopped before
			// checkpointing it.
			var captured *checkpoint.NativeProjectionIdentityV1
			if p.nativeVerified && !p.planned.upgraded {
				saved, valid := checkpoint.Parse(string(r.Checkpoint))
				if !valid {
					err = errors.New("v2: native sync lost its saved source checkpoint")
					break
				}
				verified, verifyErr := v2.VerifyNativeSync(ctx, db, p.planned.thread, r.IdentitySeed, p.planned.v2Plan, saved, s.Paths.AttachmentsDir)
				if verifyErr != nil {
					err = fmt.Errorf("post-sync native history verification for %s failed: %w", r.ThreadID, verifyErr)
					break
				}
				captured = verified.Projection
			} else {
				projection, inspectErr := v2.InspectBuiltinProjection(ctx, db, r.ThreadID)
				if inspectErr != nil {
					err = inspectErr
					break
				}
				var captureErr error
				captured, captureErr = v2.CaptureBuiltinProjectionIdentity(projection)
				if captureErr != nil {
					err = captureErr
					break
				}
			}
			cp.NativeProjection = captured
		}
		cpJSON, _ := json.Marshal(cp)
		r.SourceFingerprint = p.session.loaded.conversation.Fingerprint
		r.LastSequence = max(r.LastSequence, last)
		if first > 0 && (r.FirstSequence == 0 || first < r.FirstSequence) {
			r.FirstSequence = first
		}
		r.Checkpoint = cpJSON
		r.SourceTitle = p.planned.thread.Title
		r.SyncedAt = &now
		if !p.planned.upgraded || r.BackupPath == "" {
			r.BackupPath = backupPath
		}
		if len(p.recoveryOldRecords) > 0 {
			consolidations = append(consolidations, ledger.Consolidation{OldRecords: p.recoveryOldRecords, NewRecord: r})
		} else {
			rows = append(rows, r)
		}
		ledgerRecovered = ledgerRecovered || p.recovered
		item := syncItem{p}.result(domain.SyncSynced)
		item.TurnsAdded = added
		item.TurnsAdopted = adopted
		if first > 0 {
			item.Sequence = &domain.Sequence{First: int(first), Last: int(last)}
		}
		results = append(results, item)
		if p.events > 0 || added > 0 || adopted > 0 {
			changed = true
		}
	}
	if err != nil {
		_ = store.Close()
		rollbackAssets()
		return nil, false, err
	}
	if err = sqlite.IntegrityCheck(ctx, db); err != nil {
		_ = store.Close()
		rollbackAssets()
		return nil, false, err
	}
	if err = store.RecordSyncResults(ctx, rows, consolidations); err != nil {
		_ = store.Close()
		rollbackAssets()
		return nil, false, err
	}
	_ = store.Close()
	rollbackAssets = func() {}
	status := domain.SyncRunUpToDate
	if changed || ledgerRecovered {
		status = domain.SyncRunSynced
	}
	return &domain.SyncRunResult{SchemaVersion: 1, Status: status, Target: s.Paths.DBPath, Migration: info.Migration, Backup: &backupPath, Results: results, Warnings: warnings}, changed, nil
}

func (s *Service) buildReplacementPlans(ctx context.Context, db *sql.DB, info schema.Info, sessions []preparedSession, request Request) ([]replacementPlan, []string, error) {
	var plans []replacementPlan
	var warnings []string
	for _, session := range sessions {
		for _, state := range session.assessment.threadPlans {
			if len(state.oldRecords) == 0 {
				return nil, nil, fmt.Errorf("replacement mapping for %s is missing", state.thread.SourceKey)
			}
			old, ok := uniqueCanonicalRecords(state.oldRecords)
			if !ok {
				return nil, nil, fmt.Errorf("replacement mapping for %s is ambiguous", state.thread.SourceKey)
			}
			thread := terminalThread(state.thread)
			if !thread.CurrentBranch || hasInProgress(state.thread) {
				return nil, nil, errors.New("replacement requires a settled current source branch")
			}
			oldIDs := make([]string, 0, len(old))
			active := false
			for _, r := range old {
				exists, deleted, e := targetThreadState(ctx, db, info, r.ThreadID)
				if e != nil {
					return nil, nil, e
				}
				if !exists || deleted {
					return nil, nil, fmt.Errorf("replacement target %s is missing or deleted", r.ThreadID)
				}
				isActive, e := targetThreadActive(ctx, db, info, r.ThreadID)
				if e != nil {
					return nil, nil, e
				}
				active = active || isActive
				oldIDs = append(oldIDs, r.ThreadID)
			}
			if active {
				return nil, nil, errors.New("replacement target has an active provider runtime")
			}
			base, e := s.planThread(ctx, info, db, thread, request.Provider, old[0].ProjectID, false, request.NoResume)
			if e != nil {
				return nil, nil, e
			}
			seed := "replacement:" + thread.SourceKey + ":" + old[0].ThreadID
			newID := identity.UUID("t3-import:replacement:" + thread.SourceKey + ":" + old[0].ThreadID)
			newExists, _, e := targetThreadState(ctx, db, info, newID)
			if e != nil {
				return nil, nil, e
			}
			if newExists {
				return nil, nil, fmt.Errorf("replacement thread %s already exists; refusing ambiguous recovery", newID)
			}
			base.threadID = newID
			base.projectID = old[0].ProjectID
			base.resumable = old[0].Resumable && !request.NoResume
			if info.Profile == schema.ProfileLegacy {
				base.legacyPlan = legacy.PlanImport(thread, legacy.Target{TargetID: identity.TargetID(s.Paths.DBPath), ProjectID: base.projectID, ThreadID: newID, IdentitySeed: seed, Workspace: thread.Workspace, AttachmentsDir: s.Paths.AttachmentsDir, Migration: info.Migration}, base.legacyPlan.Provider, base.resumable)
			} else {
				opts := map[string]any{}
				for _, o := range base.provider.Options {
					opts[o.ID] = o.Value
				}
				replacementThread := thread
				replacementThread.SourceKey = seed
				base.v2Plan, e = v2.BuildPlanWithRuntimeOptions(replacementThread, newID, base.projectID, base.provider.InstanceID, base.provider.Model, opts, false, s.Paths.AttachmentsDir, base.resumable)
				if e != nil {
					return nil, nil, e
				}
			}
			base.fingerprint = session.loaded.conversation.Fingerprint
			rp := replacementPlan{session: session, planned: base, old: old, oldIDs: oldIDs}
			if info.Profile == schema.ProfileLegacy {
				at := time.Now().UTC().Format(time.RFC3339Nano)
				for n, r := range old {
					ev := legacy.Event{EventID: identity.UUID("t3-import:replacement-deleted:" + newID + ":" + r.ThreadID), AggregateKind: "thread", StreamID: r.ThreadID, Type: "thread.deleted", OccurredAt: at, ActorKind: "client", Payload: map[string]any{"threadId": r.ThreadID, "deletedAt": at}, Metadata: map[string]any{"replacedByThreadId": newID, "source": "t3-import"}, Key: fmt.Sprintf("replaced-thread.%d.deleted", n)}
					rp.legacyDeletes = append(rp.legacyDeletes, ev)
				}
				rp.events = len(base.legacyPlan.Events) + len(rp.legacyDeletes)
			} else {
				histories := make([][]v2.StoredEvent, 0, len(old))
				for _, r := range old {
					history, e := v2.InspectThread(ctx, db, r.ThreadID)
					if e != nil {
						return nil, nil, e
					}
					histories = append(histories, history)
				}
				rp.v2Plan, e = v2.BuildReplacementPlan(base.v2Plan, histories, time.Now().UTC().Format(time.RFC3339Nano), false, active)
				if e != nil {
					return nil, nil, e
				}
				rp.events = len(base.v2Plan.Events) + len(old)
			}
			if rp.events > maxSafeEvents {
				return nil, nil, withExitCode(4, fmt.Errorf("replacement would append %d events, exceeding the safe one-launch limit", rp.events))
			}
			plans = append(plans, rp)
			warnings = append(warnings, planWarnings(base)...)
		}
	}
	return plans, warnings, nil
}

func uniqueCanonicalRecords(records []ledger.Record) ([]ledger.Record, bool) {
	var out []ledger.Record
	seen := map[string]bool{}
	for _, r := range records {
		if (r.IsCanonical == nil || *r.IsCanonical) && !seen[r.ThreadID] {
			seen[r.ThreadID] = true
			out = append(out, r)
		}
	}
	return out, len(out) > 0
}

func (s *Service) executeReplacementPlans(ctx context.Context, db *sql.DB, info schema.Info, backupPath string, request Request, sessions []preparedSession) (any, bool, error) {
	plans, warnings, err := s.buildReplacementPlans(ctx, db, info, sessions, request)
	if err != nil {
		return nil, false, err
	}
	if len(plans) == 0 {
		return nil, false, errors.New("replacement has no verified target mappings")
	}
	total := 0
	for _, p := range plans {
		total += p.events
	}
	if total > maxSafeEvents {
		return nil, false, withExitCode(4, fmt.Errorf("replacement would append %d events, exceeding the safe one-launch limit of %d", total, maxSafeEvents))
	}
	var allAssets []assets.Asset
	for _, p := range plans {
		allAssets = append(allAssets, p.planned.v2Plan.Assets...)
		allAssets = append(allAssets, p.planned.legacyPlan.Assets...)
	}
	_, rollbackAssets, err := assets.Materialize(s.Paths.AttachmentsDir, allAssets)
	if err != nil {
		return nil, false, err
	}
	store, err := openLedgerStore()
	if err != nil {
		rollbackAssets()
		return nil, false, err
	}
	results := []domain.ReplaceItemResult{}
	consolidations := []ledger.Consolidation{}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, p := range plans {
		var first, last int64
		if info.Profile == schema.ProfileLegacy {
			first, last, err = legacy.Replace(ctx, db, p.planned.legacyPlan, p.legacyDeletes)
			if err == nil {
				// Transfer the canonical runtime cursor to the replacement in a
				// stopped state. Other historical runtime rows are discarded.
				if len(p.old) > 0 && p.planned.resumable {
					_, err = db.ExecContext(ctx, "UPDATE provider_session_runtime SET thread_id=?,status='stopped' WHERE thread_id=?", p.planned.threadID, p.old[0].ThreadID)
				}
				for _, old := range p.old {
					if old.ThreadID == p.old[0].ThreadID {
						continue
					}
					_, err = db.ExecContext(ctx, "DELETE FROM provider_session_runtime WHERE thread_id=?", old.ThreadID)
					if err != nil {
						break
					}
				}
			}
		} else {
			var stored []v2.StoredEvent
			stored, err = v2.AppendReplacement(ctx, db, p.v2Plan)
			if err == nil && len(stored) > 0 {
				first = stored[0].Sequence
				last = stored[len(stored)-1].Sequence
			}
		}
		if err != nil {
			break
		}
		if err = sqlite.IntegrityCheck(ctx, db); err != nil {
			break
		}
		if last == 0 {
			err = errors.New("replacement produced no target sequence")
			break
		}
		cp, e := checkpoint.ForThread(p.planned.thread)
		if e != nil {
			err = e
			break
		}
		cpJSON, _ := json.Marshal(cp)
		old := p.old[0]
		record := ledger.Record{TargetID: identity.TargetID(s.Paths.DBPath), Source: p.planned.thread.Source, SourceSessionID: p.planned.thread.SourceSessionID, SourceKey: p.planned.thread.SourceKey, CurrentSourceKey: p.planned.thread.SourceKey, SourceFingerprint: p.session.loaded.conversation.Fingerprint, ProjectID: p.planned.projectID, ThreadID: p.planned.threadID, ImportedAt: now, ImporterVersion: "1.0.0", Migration: info.Migration, FirstSequence: first, LastSequence: last, Resumable: p.planned.resumable, BackupPath: backupPath, Warnings: planWarnings(p.planned), IdentitySeed: "replacement:" + p.planned.thread.SourceKey + ":" + old.ThreadID, SourceLeafID: p.planned.thread.LeafID, SourceTitle: p.planned.thread.Title, Checkpoint: cpJSON, SyncedAt: &now, IsCanonical: boolPointer(true), ReplacedAt: &now}
		consolidations = append(consolidations, ledger.Consolidation{OldRecords: p.old, NewRecord: record})
		item := replacementItem{p}.result(domain.ReplaceReplaced)
		item.Sequence = &domain.Sequence{First: int(first), Last: int(last)}
		results = append(results, item)
	}
	if err != nil {
		_ = store.Close()
		rollbackAssets()
		return nil, false, err
	}
	if err = store.RecordConsolidations(ctx, consolidations); err != nil {
		_ = store.Close()
		rollbackAssets()
		return nil, false, err
	}
	_ = store.Close()
	rollbackAssets = func() {}
	return &domain.ReplaceRunResult{SchemaVersion: 1, Status: domain.ReplaceRunReplaced, Target: s.Paths.DBPath, Migration: info.Migration, Backup: &backupPath, Results: results, Warnings: warnings}, true, nil
}

func (s *Service) runTargetWrite(ctx context.Context, name string, request Request, run func(context.Context, *sql.DB, string) (any, bool, error)) (any, error) {
	if _, err := targetruntime.AssertT3Closed(ctx, s.Paths); err != nil {
		return nil, withExitCode(4, err)
	}
	release, err := lock.Acquire(s.Paths.StateDir)
	if err != nil {
		return nil, withExitCode(4, err)
	}
	defer release()
	if _, err := targetruntime.AssertT3Closed(ctx, s.Paths); err != nil {
		return nil, withExitCode(4, err)
	}
	db, _, err := openValidatedTarget(ctx, s.Paths, false)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	backupPath, err := backup.Create(ctx, db, s.Paths.StateDir)
	if err != nil {
		return nil, err
	}
	value, changed, err := run(ctx, db, backupPath)
	if err != nil {
		restoreErr := sqlite.Restore(context.Background(), db, backupPath)
		if restoreErr != nil {
			return nil, fmt.Errorf("%s failed: %v; verified backup restore failed: %v; recovery backup: %s", name, err, restoreErr, backupPath)
		}
		return nil, fmt.Errorf("%s failed; T3 was restored from the verified backup: %w", name, err)
	}
	if !changed {
		return value, nil
	}
	if reset := s.resetOption(request); reset {
		cacheResult, cacheErr := cache.Reset(ctx, s.Paths, cache.Options{})
		if cacheErr != nil {
			addWarning(value, "T3 data was updated, but its IndexedDB cache could not be reset: "+cacheErr.Error())
		} else {
			setCache(value, cacheResult)
			for _, warning := range cacheResult.Warnings {
				addWarning(value, warning)
			}
		}
	}
	return value, nil
}

func (s *Service) executeImportPlans(ctx context.Context, db *sql.DB, info schema.Info, backupPath string, request Request, sessions []preparedSession) (any, bool, error) {
	if err := ensureCurrentProfile(ctx, db, info); err != nil {
		return nil, false, err
	}
	planned := make([]plannedThread, 0)
	createdProjects := map[string]bool{}
	for _, session := range sessions {
		for _, assessed := range session.assessment.threadPlans {
			if assessed.status != "new" {
				continue
			}
			if assessed.adopted {
				item := assessed
				item.fingerprint = session.loaded.conversation.Fingerprint
				planned = append(planned, item)
				continue
			}
			workspaceKey := identity.CanonicalPath(assessed.thread.Workspace)
			createProject := !createdProjects[workspaceKey]
			createdProjects[workspaceKey] = true
			item, err := s.planThread(ctx, info, db, assessed.thread, request.Provider, "", createProject, request.NoResume)
			if err != nil {
				return nil, false, err
			}
			item.fingerprint = session.loaded.conversation.Fingerprint
			item.status = assessed.status
			if threadExists(ctx, db, info, item.threadID) {
				return nil, false, fmt.Errorf("target thread %s changed after review; no data was written", item.threadID)
			}
			planned = append(planned, item)
		}
	}
	return s.writePlannedImports(ctx, db, info, backupPath, request, planned)
}

func (s *Service) planImports(ctx context.Context, request Request, info schema.Info, sessions []preparedSession, dryRun bool) (*domain.ImportRunResult, error) {
	db, _, err := openValidatedTarget(ctx, s.Paths, true)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	planned := make([]plannedThread, 0)
	createdProjects := map[string]bool{}
	for _, session := range sessions {
		for _, assessed := range session.assessment.threadPlans {
			if assessed.status != "new" {
				continue
			}
			if assessed.adopted {
				item := assessed
				item.fingerprint = session.loaded.conversation.Fingerprint
				planned = append(planned, item)
				continue
			}
			workspaceKey := identity.CanonicalPath(assessed.thread.Workspace)
			createProject := !createdProjects[workspaceKey]
			createdProjects[workspaceKey] = true
			item, err := s.planThread(ctx, info, db, assessed.thread, request.Provider, "", createProject, request.NoResume)
			if err != nil {
				return nil, err
			}
			item.fingerprint = session.loaded.conversation.Fingerprint
			planned = append(planned, item)
		}
	}
	results := importResults(planned, domain.ImportDryRun)
	status := domain.ImportRunDryRun
	if len(results) == 0 {
		status = domain.ImportRunAlreadyImported
	}
	return &domain.ImportRunResult{SchemaVersion: 1, Status: status, Target: s.Paths.DBPath, Migration: info.Migration, Results: results, Warnings: []string{}}, nil
}

func (s *Service) writePlannedImports(ctx context.Context, db *sql.DB, info schema.Info, backupPath string, request Request, planned []plannedThread) (*domain.ImportRunResult, bool, error) {
	if len(planned) == 0 {
		return nil, false, errors.New("import has no terminal threads")
	}
	count := 0
	for _, item := range planned {
		count += eventCount(item)
	}
	if count > maxSafeEvents {
		return nil, false, withExitCode(4, fmt.Errorf("the compact import would append %d events, exceeding the safe one-launch limit of %d; import fewer conversations at a time", count, maxSafeEvents))
	}
	allAssets := []assets.Asset{}
	for _, item := range planned {
		if item.adopted {
			continue
		}
		if item.v2Plan.ThreadID != "" {
			allAssets = append(allAssets, item.v2Plan.Assets...)
		} else {
			allAssets = append(allAssets, item.legacyPlan.Assets...)
		}
	}
	createdFiles, rollbackAssets, err := assets.Materialize(s.Paths.AttachmentsDir, allAssets)
	if err != nil {
		return nil, false, err
	}
	_ = createdFiles
	results := importResults(planned, domain.ImportImported)
	var ranges []legacy.SequenceRange
	var v2Sequences [][]v2.StoredEvent
	if info.Profile == schema.ProfileLegacy {
		plans := make([]legacy.Plan, len(planned))
		for index, item := range planned {
			plans[index] = item.legacyPlan
		}
		ranges, err = legacy.ImportBatch(ctx, db, plans)
	} else {
		for _, item := range planned {
			if item.adopted {
				var stored []v2.StoredEvent
				if item.adoptHeadEvent != nil {
					expected, readErr := v2.Read(ctx, db, item.threadID)
					if readErr != nil {
						err = readErr
						break
					}
					stored, err = v2.AppendSync(ctx, db, v2.SyncPlan{ThreadID: item.threadID, ProjectID: item.projectID, ProviderInstanceID: item.provider.InstanceID, Expected: expected, Events: []v2.Event{*item.adoptHeadEvent}})
					if err != nil {
						break
					}
					verified, verifyErr := v2.MatchBuiltinImport(ctx, db, item.thread, []domain.CanonicalThread{item.thread}, item.provider.InstanceID, item.projectID, s.Paths.AttachmentsDir)
					if verifyErr != nil || verified.HeadEvent != nil || len(stored) != 1 || stored[0].Event.ID != item.adoptHeadEvent.ID {
						err = fmt.Errorf("built-in Claude head attachment could not be verified: %v", verifyErr)
						if verifyErr == nil {
							err = errors.New("built-in Claude head attachment readback did not match the verified source")
						}
						break
					}
				}
				v2Sequences = append(v2Sequences, stored)
				continue
			}
			stored, appendErr := v2.AppendPlan(ctx, db, item.v2Plan)
			if appendErr != nil {
				err = appendErr
				break
			}
			v2Sequences = append(v2Sequences, stored)
		}
	}
	if err != nil {
		rollbackAssets()
		return nil, false, err
	}
	if err := sqlite.IntegrityCheck(ctx, db); err != nil {
		rollbackAssets()
		return nil, false, err
	}
	for i := range results {
		var first, last int64
		if info.Profile == schema.ProfileLegacy && i < len(ranges) {
			first, last = ranges[i].First, ranges[i].Last
		} else if info.Profile == schema.ProfileV2 && i < len(v2Sequences) && len(v2Sequences[i]) > 0 {
			first, last = v2Sequences[i][0].Sequence, v2Sequences[i][len(v2Sequences[i])-1].Sequence
			if planned[i].adopted {
				first = planned[i].firstSequence
			}
		} else if planned[i].adopted {
			first, last = planned[i].firstSequence, planned[i].lastSequence
		}
		if first > 0 {
			results[i].Sequence = &domain.Sequence{First: int(first), Last: int(last)}
		}
	}
	store, err := openLedgerStore()
	if err != nil {
		rollbackAssets()
		return nil, false, err
	}
	ledgerRows := make([]ledger.Record, 0, len(planned))
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for i, item := range planned {
		var first, last int64
		if info.Profile == schema.ProfileLegacy && i < len(ranges) {
			first, last = ranges[i].First, ranges[i].Last
		} else if info.Profile == schema.ProfileV2 && i < len(v2Sequences) && len(v2Sequences[i]) > 0 {
			first, last = v2Sequences[i][0].Sequence, v2Sequences[i][len(v2Sequences[i])-1].Sequence
		} else if item.adopted {
			first, last = item.firstSequence, item.lastSequence
		}
		if item.adopted {
			if item.adoptedRecord == nil {
				_ = store.Close()
				rollbackAssets()
				return nil, false, errors.New("verified built-in adoption is missing its recovered ledger record")
			}
			recovered := *item.adoptedRecord
			recovered.SourceFingerprint = item.fingerprint
			recovered.BackupPath = backupPath
			recovered.FirstSequence = first
			recovered.LastSequence = max(recovered.LastSequence, last)
			recovered.Checkpoint = item.checkpoint
			recovered.Warnings = planWarnings(item)
			ledgerRows = append(ledgerRows, recovered)
		} else {
			ledgerRows = append(ledgerRows, ledger.Record{TargetID: identity.TargetID(s.Paths.DBPath), Source: item.thread.Source, SourceSessionID: item.thread.SourceSessionID, SourceKey: item.thread.SourceKey, CurrentSourceKey: item.thread.SourceKey, SourceFingerprint: item.fingerprint, ProjectID: item.projectID, ThreadID: item.threadID, ImportedAt: now, ImporterVersion: "1.0.0", Migration: info.Migration, FirstSequence: first, LastSequence: last, Resumable: item.resumable, BackupPath: backupPath, Warnings: planWarnings(item), IdentitySeed: item.thread.SourceKey, SourceLeafID: item.thread.LeafID, SourceTitle: item.thread.Title, Checkpoint: item.checkpoint, IsCanonical: boolPointer(true)})
		}
	}
	if err = store.RecordImports(ctx, ledgerRows); err != nil {
		_ = store.Close()
		rollbackAssets()
		return nil, false, err
	}
	_ = store.Close()
	rollbackAssets = func() {}
	warnings := []string{}
	for _, item := range planned {
		warnings = append(warnings, planWarnings(item)...)
	}
	changed := false
	for _, item := range planned {
		changed = changed || !item.adopted || item.adoptHeadEvent != nil
	}
	return &domain.ImportRunResult{SchemaVersion: 1, Status: domain.ImportRunImported, Target: s.Paths.DBPath, Migration: info.Migration, Backup: &backupPath, Results: results, Warnings: warnings}, changed, nil
}

func importResults(planned []plannedThread, status domain.ImportItemStatus) []domain.ImportItemResult {
	results := make([]domain.ImportItemResult, 0, len(planned))
	for _, item := range planned {
		thread := item.thread
		messages, activities, attachments := 0, 0, 0
		for _, turn := range thread.Turns {
			messages += 1 + len(turn.Assistant)
			activities += len(turn.Activities)
			attachments += len(turn.User.Attachments)
		}
		itemStatus := status
		if item.adopted && status != domain.ImportDryRun {
			itemStatus = domain.ImportAdopted
		}
		results = append(results, domain.ImportItemResult{Source: thread.Source, SourceID: thread.SourceSessionID, SourceKey: thread.SourceKey, Status: itemStatus, ThreadID: item.threadID, ProjectID: item.projectID, Title: thread.Title, Turns: len(thread.Turns), Messages: messages, Activities: activities + boolAsInt(!thread.CurrentBranch), Events: eventCount(item), Attachments: attachments, Resumable: item.resumable, Warnings: planWarnings(item)})
	}
	return results
}

func boolAsInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func planWarnings(item plannedThread) []string {
	result := append([]string(nil), item.warnings...)
	if item.v2Plan.ThreadID != "" {
		return append(result, item.v2Plan.Warnings...)
	}
	return append(result, item.legacyPlan.Warnings...)
}

func openLedgerStore() (*ledger.Store, error) {
	path, err := ledger.DefaultPath()
	if err != nil {
		return nil, err
	}
	return ledger.Open(path)
}

func addWarning(value any, warning string) {
	switch result := value.(type) {
	case *domain.ImportRunResult:
		result.Warnings = append(result.Warnings, warning)
	case *domain.SyncRunResult:
		result.Warnings = append(result.Warnings, warning)
	case *domain.ReplaceRunResult:
		result.Warnings = append(result.Warnings, warning)
	}
}

func setCache(value any, cacheResult domain.CacheResetResult) {
	switch result := value.(type) {
	case *domain.ImportRunResult:
		result.Cache = &cacheResult
	case *domain.SyncRunResult:
		result.Cache = &cacheResult
	case *domain.ReplaceRunResult:
		result.Cache = &cacheResult
	}
}

func boolPointer(value bool) *bool { return &value }
