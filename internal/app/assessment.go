package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/runinit/t3-syncaroo/internal/checkpoint"
	"github.com/runinit/t3-syncaroo/internal/domain"
	"github.com/runinit/t3-syncaroo/internal/identity"
	"github.com/runinit/t3-syncaroo/internal/target/ledger"
	"github.com/runinit/t3-syncaroo/internal/target/legacy"
	"github.com/runinit/t3-syncaroo/internal/target/schema"
	"github.com/runinit/t3-syncaroo/internal/target/v2"
)

type threadAssessment struct {
	plan               plannedThread
	records            []ledger.Record
	record             *ledger.Record
	exists             bool
	deleted            bool
	active             bool
	sourceActive       bool
	recovered          bool
	v2History          []v2.StoredEvent
	syncStatus         string
	titleChanged       bool
	newTurns           int
	adopted            int
	recoveryOldRecords []ledger.Record
}

func (s *Service) assess(ctx context.Context, db *sql.DB, info schema.Info, records []ledger.Record, conversation domain.CanonicalConversation, mode Mode, provider string, noResume bool) (sessionAssessment, error) {
	assessment := sessionAssessment{conversation: conversation, imports: []ledger.Record{}}
	preview := PreviewSession{Summary: conversation.Summary, Sync: SyncPreview{Status: "new", Selectable: mode == ModeAuto}, Replacement: ReplacementPreview{Status: "not-imported"}}
	var threads []threadAssessment
	for _, sourceThread := range conversation.Threads {
		thread := terminalThread(sourceThread)
		if len(thread.Turns) == 0 {
			if preview.Sync.Status == "new" {
				preview.Sync.Status = "active-only"
			}
			continue
		}
		if info.Profile == schema.ProfileV2 && thread.Source == domain.SourceCodex && !thread.CurrentBranch {
			threadAssessment := threadAssessment{syncStatus: "branch-sync-unsupported", sourceActive: hasInProgress(sourceThread)}
			threads = append(threads, threadAssessment)
			continue
		}
		candidates, record := matchRecord(records, thread)
		project := ""
		if record != nil {
			project = record.ProjectID
		}
		plan, err := s.planThread(ctx, info, db, thread, provider, project, false, noResume)
		if err != nil {
			return sessionAssessment{}, err
		}
		state := threadAssessment{plan: plan, records: candidates, record: record, newTurns: len(thread.Turns), sourceActive: hasInProgress(sourceThread)}
		adoptionHandled := false
		if record == nil && len(candidates) == 0 && info.Profile == schema.ProfileV2 && mode == ModeAuto {
			builtinID := "import:" + plan.provider.InstanceID + ":" + thread.SourceSessionID
			builtinExists, builtinDeleted, stateErr := targetThreadState(ctx, db, info, builtinID)
			if stateErr != nil {
				return sessionAssessment{}, stateErr
			}
			if builtinExists && !builtinDeleted {
				adoptionHandled = true
				state.exists = true
				state.active, err = targetThreadActive(ctx, db, info, builtinID)
				if err != nil {
					return sessionAssessment{}, err
				}
				if state.active {
					state.syncStatus = "history-diverged"
					state.plan.warnings = []string{"The built-in T3 task has an active provider session; adoption left it unchanged."}
				} else {
					recovered, match, matchErr := s.recoverBuiltinV2Import(ctx, db, info, plan, conversation.Threads, conversation.Fingerprint)
					if matchErr != nil {
						state.syncStatus = "history-diverged"
						state.plan.warnings = []string{matchErr.Error()}
					} else {
						state.record = &recovered
						state.records = []ledger.Record{recovered}
						state.newTurns = len(thread.Turns)
						state.plan.threadID = match.ThreadID
						state.plan.projectID = recovered.ProjectID
						state.plan.adopted = true
						state.plan.adoptedRecord = &recovered
						state.plan.adoptHeadEvent = match.HeadEvent
						state.plan.firstSequence = match.FirstSequence
						state.plan.lastSequence = match.LastSequence
						state.plan.recovered = true
						state.plan.checkpoint = recovered.Checkpoint
						state.plan.warnings = append([]string(nil), recovered.Warnings...)
						state.syncStatus = "new"
					}
				}
			}
		}
		if !adoptionHandled && record != nil {
			state.newTurns = 0
			state.exists, state.deleted, err = targetThreadState(ctx, db, info, record.ThreadID)
			if err != nil {
				return sessionAssessment{}, err
			}
			if state.exists && !state.deleted {
				state.active, err = targetThreadActive(ctx, db, info, record.ThreadID)
				if err != nil {
					return sessionAssessment{}, err
				}
			} else if info.Profile == schema.ProfileV2 && state.exists && state.deleted {
				recovered, recoveredPlan, ok, recoverErr := s.recoverV2Replacement(ctx, db, info, plan, *record)
				if recoverErr != nil {
					return sessionAssessment{}, recoverErr
				}
				if ok {
					old := *record
					old.IsCanonical = boolPointer(false)
					old.SupersededByThreadID = &recovered.ThreadID
					state.record = &recovered
					state.records = []ledger.Record{old, recovered}
					state.recoveryOldRecords = []ledger.Record{*record}
					state.recovered = true
					state.exists, state.deleted = true, false
					state.active, err = targetThreadActive(ctx, db, info, recovered.ThreadID)
					if err != nil {
						return sessionAssessment{}, err
					}
					state.plan.threadID = recovered.ThreadID
					state.plan.projectID = recovered.ProjectID
					state.plan.resumable = recovered.Resumable
					state.plan.v2Plan = recoveredPlan
					state.plan.recovered = true
					state.plan.recoveryOldRecords = append([]ledger.Record(nil), state.recoveryOldRecords...)
				}
			}
		} else if !adoptionHandled && len(candidates) == 0 {
			state.exists, state.deleted, err = targetThreadState(ctx, db, info, plan.threadID)
			if err != nil {
				return sessionAssessment{}, err
			}
			if state.exists && !state.deleted {
				state.active, err = targetThreadActive(ctx, db, info, plan.threadID)
				if err != nil {
					return sessionAssessment{}, err
				}
				var recovered ledger.Record
				var ok bool
				if info.Profile == schema.ProfileV2 {
					recovered, ok, err = s.recoverExactV2Import(ctx, db, info, plan)
				} else {
					recovered, ok, err = s.recoverExactLegacyImport(ctx, db, info, plan)
				}
				recoverErr := err
				if recoverErr != nil {
					return sessionAssessment{}, recoverErr
				}
				if ok {
					state.record = &recovered
					state.records = []ledger.Record{recovered}
					state.recovered = true
					state.newTurns = 0
				}
			}
		}
		if !adoptionHandled && info.Profile == schema.ProfileV2 && state.exists && !state.deleted && !state.active {
			needsUpgrade := state.record == nil || state.record.TargetID != identity.TargetID(s.Paths.DBPath)
			if state.record != nil && !needsUpgrade {
				if saved, valid := checkpoint.Parse(string(state.record.Checkpoint)); !valid || saved.Version != 2 || saved.V2.NativeProjection == nil {
					needsUpgrade = true
				}
			}
			if needsUpgrade {
				var prior *ledger.Record
				if state.record != nil {
					copyRecord := *state.record
					prior = &copyRecord
				}
				recovered, upgraded, upgradeErr := s.recoverUpgradedV2Import(ctx, db, info, state.plan, prior, conversation.Fingerprint)
				if upgradeErr == nil {
					state.record = &recovered
					state.records = []ledger.Record{recovered}
					state.recovered = true
					state.newTurns = max(0, len(thread.Turns)-upgraded.PrefixTurns)
					state.plan.threadID = recovered.ThreadID
					state.plan.projectID = recovered.ProjectID
					state.plan.resumable = recovered.Resumable
					state.plan.checkpoint = recovered.Checkpoint
					state.plan.upgraded = true
					state.plan.recovered = true
					state.plan.warnings = append([]string(nil), recovered.Warnings...)
					state.syncStatus = "syncable"
					adoptionHandled = true
				} else if prior != nil && prior.TargetID != identity.TargetID(s.Paths.DBPath) {
					state.syncStatus = "history-diverged"
					state.plan.warnings = []string{upgradeErr.Error()}
					adoptionHandled = true
				}
			}
		}
		if adoptionHandled {
			// A verified built-in history is routed through the import operation so
			// it records ownership without replaying native T3 events.
		} else if info.Profile == schema.ProfileLegacy {
			state.syncStatus, state.newTurns, state.adopted, state.titleChanged, err = s.legacySyncStatus(ctx, db, state, thread)
			if err != nil {
				state.syncStatus = "history-diverged"
			}
		} else {
			state.syncStatus, state.newTurns, state.adopted, err = v2SyncStatus(ctx, db, state, thread, s.Paths.AttachmentsDir)
			if err != nil {
				state.syncStatus = "history-diverged"
			}
		}
		if state.recovered && state.syncStatus == "up-to-date" {
			state.syncStatus = "syncable"
		}
		state.plan.status = state.syncStatus
		state.plan.recovered = state.recovered
		state.plan.oldRecords = append([]ledger.Record(nil), state.records...)
		threads = append(threads, state)
	}
	if len(threads) == 0 {
		if preview.Sync.Status == "new" {
			preview.Sync.Status = "active-only"
		}
		preview.Sync.Selectable = false
		preview.Replacement.Status = "active-source"
		return sessionAssessment{preview: preview, conversation: conversation}, nil
	}
	preview.ImportPreview = summarizeThreads(conversation.Threads)
	newCount, syncableCount, divergedCount, missingCount, branchUnsupported := 0, 0, 0, 0, 0
	var oldIDs []string
	replacementReady := true
	for _, state := range threads {
		if state.syncStatus == "branch-sync-unsupported" {
			branchUnsupported++
			replacementReady = false
			continue
		}
		if state.syncStatus == "new" {
			newCount++
		}
		if state.syncStatus == "syncable" {
			syncableCount++
		}
		if state.syncStatus == "history-diverged" {
			divergedCount++
		}
		if state.syncStatus == "target-missing" {
			missingCount++
		}
		if !state.plan.thread.CurrentBranch || state.active || state.sourceActive {
			replacementReady = false
		}
		for _, old := range state.records {
			if old.IsCanonical == nil || *old.IsCanonical {
				oldIDs = append(oldIDs, old.ThreadID)
			}
		}
		if state.record != nil {
			assessment.imports = append(assessment.imports, *state.record)
		}
		assessment.threadPlans = append(assessment.threadPlans, state.plan)
	}
	sort.Strings(oldIDs)
	status := "up-to-date"
	switch {
	case branchUnsupported > 0:
		status = "branch-sync-unsupported"
	case missingCount > 0:
		status = "target-missing"
	case divergedCount > 0:
		status = "history-diverged"
	case newCount > 0:
		status = "new"
	case syncableCount > 0:
		status = "syncable"
	}
	preview.Sync = SyncPreview{Status: status, Selectable: mode == ModeAuto && (status == "new" || status == "syncable") || mode == ModeSync && status == "syncable"}
	for _, state := range threads {
		preview.Sync.NewTurns += state.newTurns
		preview.Sync.AdoptedTurns += state.adopted
		preview.Sync.TitleChanged = preview.Sync.TitleChanged || state.titleChanged
	}
	if status == "history-diverged" && len(oldIDs) == 0 && len(assessment.imports) > 0 {
		replacementReady = false
	}
	replacement := ReplacementPreview{Status: "not-imported", OldThreadIDs: oldIDs, NewThreadID: identity.ThreadID(conversation.Threads[0].SourceKey, conversation.Threads[0].SourceSessionID, conversation.Threads[0].Source == domain.SourceCodex)}
	if len(oldIDs) > 0 {
		replacement.PreviouslyImported = true
		replacement.OldThreadID = oldIDs[0]
		replacement.Status = "history-conflict"
		if status == "history-diverged" {
			replacement.Status = "replaceable"
		}
		for _, state := range threads {
			replacement.Turns += len(state.plan.thread.Turns)
			replacement.Events += eventCount(state.plan)
			if state.plan.v2Plan.ThreadID != "" {
				replacement.Attachments += len(state.plan.v2Plan.Assets)
			} else {
				replacement.Attachments += len(state.plan.legacyPlan.Assets)
			}
		}
		replacement.Selectable = replacement.Status == "replaceable" && replacementReady
	}
	if status == "target-missing" {
		replacement.Status = "target-missing"
	}
	if branchUnsupported > 0 {
		replacement.Status = "branch-replace-unsupported"
	}
	if mode == ModeReplace && replacement.Status == "not-imported" {
		replacement.Status = "not-imported"
	}
	preview.Replacement = replacement
	return sessionAssessment{preview: preview, conversation: conversation, imports: assessment.imports, threadPlans: assessment.threadPlans}, nil
}

func (s *Service) recoverExactV2Import(ctx context.Context, db *sql.DB, info schema.Info, plan plannedThread) (ledger.Record, bool, error) {
	history, err := v2.InspectThread(ctx, db, plan.threadID)
	if err != nil {
		return ledger.Record{}, false, nil
	}
	full := plan.v2Plan
	syncPlan, err := v2.BuildSyncPlan(history, full)
	if err != nil || len(syncPlan.Events) != 0 {
		return ledger.Record{}, false, nil
	}
	var projectID string
	if err = db.QueryRowContext(ctx, `SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id=? AND deleted_at IS NULL`, plan.threadID).Scan(&projectID); err != nil || projectID != plan.projectID {
		return ledger.Record{}, false, nil
	}
	if plan.resumable && plan.v2Plan.Runtime != nil {
		var cursor string
		if err = db.QueryRowContext(ctx, `SELECT resume_cursor_json FROM provider_session_runtime WHERE thread_id=? AND lower(status) NOT IN ('running','active','starting')`, plan.threadID).Scan(&cursor); err != nil || cursor != plan.v2Plan.Runtime.ResumeCursorJSON {
			return ledger.Record{}, false, nil
		}
	}
	checkpointValue, err := checkpoint.ForThread(plan.thread)
	if err != nil {
		return ledger.Record{}, false, err
	}
	checkpointJSON, err := json.Marshal(checkpointValue)
	if err != nil {
		return ledger.Record{}, false, err
	}
	return ledger.Record{
		TargetID: identity.TargetID(s.Paths.DBPath), Source: plan.thread.Source, SourceSessionID: plan.thread.SourceSessionID,
		SourceKey: plan.thread.SourceKey, CurrentSourceKey: plan.thread.SourceKey, SourceFingerprint: "",
		ProjectID: plan.projectID, ThreadID: plan.threadID, ImportedAt: time.Now().UTC().Format(time.RFC3339Nano),
		ImporterVersion: "1.0.0", Migration: info.Migration, FirstSequence: history[0].Sequence, LastSequence: history[len(history)-1].Sequence,
		Resumable: plan.resumable, BackupPath: "", Warnings: planWarnings(plan), IdentitySeed: plan.thread.SourceKey,
		SourceLeafID: plan.thread.LeafID, SourceTitle: plan.thread.Title, Checkpoint: checkpointJSON, IsCanonical: boolPointer(true),
	}, true, nil
}

func (s *Service) recoverBuiltinV2Import(ctx context.Context, db *sql.DB, info schema.Info, plan plannedThread, candidates []domain.CanonicalThread, fingerprint string) (ledger.Record, v2.BuiltinMatch, error) {
	match, err := v2.MatchBuiltinImport(ctx, db, plan.thread, candidates, plan.provider.InstanceID, plan.projectID, s.Paths.AttachmentsDir)
	if err != nil {
		return ledger.Record{}, v2.BuiltinMatch{}, err
	}
	checkpointValue, err := checkpoint.ForThread(plan.thread)
	if err != nil {
		return ledger.Record{}, v2.BuiltinMatch{}, err
	}
	if match.NativeProjection == nil {
		return ledger.Record{}, v2.BuiltinMatch{}, errors.New("v2: adopted built-in task has no verified native projection identity")
	}
	checkpointValue.NativeProjection = match.NativeProjection
	checkpointJSON, err := json.Marshal(checkpointValue)
	if err != nil {
		return ledger.Record{}, v2.BuiltinMatch{}, err
	}
	var headID *string
	if plan.thread.Source == domain.SourceClaude {
		if value, ok := plan.thread.ResumeCursor["resumeSessionAt"].(string); ok && value != "" {
			headID = &value
		}
	}
	warning := "Adopted the verified T3 built-in import without replaying its history."
	record := ledger.Record{
		TargetID: identity.TargetID(s.Paths.DBPath), Source: plan.thread.Source, SourceSessionID: plan.thread.SourceSessionID,
		SourceKey: plan.thread.SourceKey, CurrentSourceKey: plan.thread.SourceKey, SourceFingerprint: fingerprint,
		ProjectID: plan.projectID, ThreadID: match.ThreadID, ImportedAt: time.Now().UTC().Format(time.RFC3339Nano),
		ImporterVersion: "1.0.0", Migration: info.Migration, FirstSequence: match.FirstSequence, LastSequence: match.LastSequence,
		Resumable: plan.resumable, BackupPath: "", Warnings: []string{warning}, IdentitySeed: plan.thread.SourceKey,
		SourceLeafID: plan.thread.LeafID, NativeConversationHeadID: headID, SourceTitle: plan.thread.Title,
		Checkpoint: checkpointJSON, IsCanonical: boolPointer(true),
	}
	return record, match, nil
}

func (s *Service) recoverUpgradedV2Import(ctx context.Context, db *sql.DB, info schema.Info, plan plannedThread, prior *ledger.Record, fingerprint string) (ledger.Record, v2.UpgradedMatch, error) {
	thread := terminalThread(plan.thread)
	threadID, projectID, identitySeed := plan.threadID, plan.projectID, thread.SourceKey
	resumable := plan.resumable
	var sourceFingerprint string
	var savedCheckpoint json.RawMessage
	var savedHead *string
	if prior != nil {
		if prior.Source != thread.Source || prior.SourceSessionID != thread.SourceSessionID || prior.ThreadID == "" || prior.ProjectID == "" || prior.IdentitySeed == "" {
			return ledger.Record{}, v2.UpgradedMatch{}, errors.New("v2: saved pre-upgrade ledger mapping does not match the selected source session")
		}
		if thread.Source == domain.SourceCodex && prior.SourceKey != thread.SourceKey && prior.CurrentSourceKey != thread.SourceKey {
			return ledger.Record{}, v2.UpgradedMatch{}, errors.New("v2: Codex source identity changed after the pre-upgrade import")
		}
		threadID, projectID, identitySeed = prior.ThreadID, prior.ProjectID, prior.IdentitySeed
		resumable = prior.Resumable
		sourceFingerprint = prior.SourceFingerprint
		savedCheckpoint = prior.Checkpoint
		savedHead = prior.NativeConversationHeadID
	}
	thread.SourceKey = identitySeed
	full := plan.v2Plan
	if prior != nil {
		var err error
		full, err = v2PlanForRecord(thread, *prior, plan.provider, s.Paths.AttachmentsDir)
		if err != nil {
			return ledger.Record{}, v2.UpgradedMatch{}, err
		}
	}
	nativeThreadID := thread.SourceSessionID
	if thread.Source == domain.SourceCodex {
		if value, ok := thread.ResumeCursor["threadId"].(string); ok && value != "" {
			nativeThreadID = value
		}
	} else if value, ok := thread.ResumeCursor["resume"].(string); ok && value != "" {
		nativeThreadID = value
	}
	if sourceFingerprint == "" {
		sourceFingerprint = fingerprint
	}
	match, err := v2.VerifyUpgradedPrefix(ctx, db, thread, full, v2.UpgradedExpectation{
		ThreadID: threadID, ProjectID: projectID, ProviderInstanceID: plan.provider.InstanceID,
		SourceSessionID: thread.SourceSessionID, IdentitySeed: identitySeed,
		SourceFingerprint: sourceFingerprint, CurrentFingerprint: fingerprint,
		Checkpoint: savedCheckpoint, Resumable: resumable, NativeThreadID: nativeThreadID,
		NativeConversationHeadID: savedHead,
	}, s.Paths.AttachmentsDir)
	if err != nil {
		return ledger.Record{}, v2.UpgradedMatch{}, err
	}
	warning := "Recovered the verified pre-upgrade T3 task and retained its original backup path."
	record := ledger.Record{}
	if prior != nil {
		record = *prior
		record.Warnings = append(append([]string(nil), prior.Warnings...), warning)
		record.SourceKey = prior.SourceKey
	} else {
		record = ledger.Record{
			TargetID: identity.TargetID(s.Paths.DBPath), Source: thread.Source, SourceSessionID: thread.SourceSessionID,
			SourceKey: thread.SourceKey, ImportedAt: time.Now().UTC().Format(time.RFC3339Nano),
			ImporterVersion: "1.0.0", Resumable: resumable, Warnings: []string{warning}, IdentitySeed: identitySeed,
			IsCanonical: boolPointer(true),
		}
	}
	record.TargetID = identity.TargetID(s.Paths.DBPath)
	record.Source = thread.Source
	record.SourceSessionID = thread.SourceSessionID
	record.SourceFingerprint = fingerprint
	record.ProjectID = projectID
	record.ThreadID = threadID
	record.ImporterVersion = "1.0.0"
	record.Migration = info.Migration
	record.FirstSequence = match.FirstSequence
	record.LastSequence = match.LastSequence
	record.Resumable = resumable
	record.IdentitySeed = identitySeed
	record.CurrentSourceKey = thread.SourceKey
	record.SourceLeafID = thread.LeafID
	if thread.Source == domain.SourceClaude && resumable {
		if head, ok := thread.ResumeCursor["resumeSessionAt"].(string); ok && head != "" {
			record.NativeConversationHeadID = &head
		}
	}
	record.SourceTitle = thread.Title
	record.Checkpoint = match.Checkpoint
	record.IsCanonical = boolPointer(true)
	return record, match, nil
}

func (s *Service) recoverV2Replacement(ctx context.Context, db *sql.DB, info schema.Info, plan plannedThread, previous ledger.Record) (ledger.Record, v2.Plan, bool, error) {
	seed := "replacement:" + plan.thread.SourceKey + ":" + previous.ThreadID
	threadID := identity.UUID("t3-import:replacement:" + plan.thread.SourceKey + ":" + previous.ThreadID)
	replacementThread := plan.thread
	replacementThread.SourceKey = seed
	replacementPlan, err := v2.BuildPlanWithRuntimeOptions(replacementThread, threadID, previous.ProjectID, plan.provider.InstanceID, plan.provider.Model, providerOptionMap(plan.provider.Options), false, s.Paths.AttachmentsDir, previous.Resumable)
	if err != nil {
		return ledger.Record{}, v2.Plan{}, false, nil
	}
	history, err := v2.InspectThread(ctx, db, threadID)
	if err != nil {
		return ledger.Record{}, v2.Plan{}, false, nil
	}
	suffix, err := v2.BuildSyncPlan(history, replacementPlan)
	if err != nil {
		return ledger.Record{}, v2.Plan{}, false, nil
	}
	_ = suffix // A matching persisted prefix may safely finish syncing a later source suffix.
	var projectID string
	if err = db.QueryRowContext(ctx, `SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id=? AND deleted_at IS NULL`, threadID).Scan(&projectID); err != nil || projectID != previous.ProjectID {
		return ledger.Record{}, v2.Plan{}, false, nil
	}
	var persistedTurns int
	if err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM orchestration_v2_projection_turn_items WHERE thread_id=? AND type='user_message'`, threadID).Scan(&persistedTurns); err != nil || persistedTurns > len(plan.thread.Turns) {
		return ledger.Record{}, v2.Plan{}, false, nil
	}
	prefixThread := replacementThread
	prefixThread.Turns = append([]domain.CanonicalTurn(nil), replacementThread.Turns[:persistedTurns]...)
	prefixThread.ResumeCursor = resumeCursorForPrefix(replacementThread, persistedTurns)
	if active, activeErr := targetThreadActive(ctx, db, info, threadID); activeErr != nil || active {
		return ledger.Record{}, v2.Plan{}, false, activeErr
	}
	oldHistory, err := v2.Read(ctx, db, previous.ThreadID)
	if err != nil {
		return ledger.Record{}, v2.Plan{}, false, nil
	}
	deletedByReplacement := false
	for _, row := range oldHistory {
		if row.Event.Type != "thread.deleted" {
			continue
		}
		var metadata map[string]any
		if json.Unmarshal(row.Event.Metadata, &metadata) == nil && metadata["replacedByThreadId"] == threadID {
			deletedByReplacement = true
		}
	}
	if !deletedByReplacement {
		return ledger.Record{}, v2.Plan{}, false, nil
	}
	if replacementPlan.Runtime != nil {
		prefixRuntimePlan, planErr := v2.BuildPlanWithRuntimeOptions(prefixThread, threadID, previous.ProjectID, plan.provider.InstanceID, plan.provider.Model, providerOptionMap(plan.provider.Options), false, s.Paths.AttachmentsDir, previous.Resumable)
		if planErr != nil || prefixRuntimePlan.Runtime == nil {
			return ledger.Record{}, v2.Plan{}, false, nil
		}
		var cursor string
		if err = db.QueryRowContext(ctx, `SELECT resume_cursor_json FROM provider_session_runtime WHERE thread_id=? AND lower(status) NOT IN ('running','active','starting')`, threadID).Scan(&cursor); err != nil || cursor != prefixRuntimePlan.Runtime.ResumeCursorJSON {
			return ledger.Record{}, v2.Plan{}, false, nil
		}
	}
	checkpointValue, err := checkpoint.ForThread(prefixThread)
	if err != nil {
		return ledger.Record{}, v2.Plan{}, false, err
	}
	checkpointJSON, err := json.Marshal(checkpointValue)
	if err != nil {
		return ledger.Record{}, v2.Plan{}, false, err
	}
	deletedAt := ""
	for _, row := range oldHistory {
		if row.Event.Type != "thread.deleted" {
			continue
		}
		var payload map[string]any
		if json.Unmarshal(row.Event.Payload, &payload) == nil && payload["threadId"] == previous.ThreadID {
			deletedAt, _ = payload["deletedAt"].(string)
		}
	}
	var replacedAt *string
	if deletedAt != "" {
		replacedAt = &deletedAt
	}
	recovered := ledger.Record{
		TargetID: identity.TargetID(s.Paths.DBPath), Source: plan.thread.Source, SourceSessionID: plan.thread.SourceSessionID,
		SourceKey: plan.thread.SourceKey, CurrentSourceKey: plan.thread.SourceKey, ProjectID: previous.ProjectID, ThreadID: threadID,
		ImportedAt: time.Now().UTC().Format(time.RFC3339Nano), ImporterVersion: "1.0.0", Migration: info.Migration,
		FirstSequence: history[0].Sequence, LastSequence: history[len(history)-1].Sequence, Resumable: replacementPlan.Runtime != nil,
		BackupPath: "", Warnings: planWarnings(plan), IdentitySeed: seed, SourceLeafID: plan.thread.LeafID,
		SourceTitle: plan.thread.Title, Checkpoint: checkpointJSON, IsCanonical: boolPointer(true), ReplacedAt: replacedAt,
	}
	return recovered, replacementPlan, true, nil
}

func resumeCursorForPrefix(thread domain.CanonicalThread, turns int) map[string]any {
	cursor := make(map[string]any, len(thread.ResumeCursor))
	for key, value := range thread.ResumeCursor {
		cursor[key] = value
	}
	if thread.Source == domain.SourceClaude {
		cursor["turnCount"] = turns
		if turns > 0 {
			assistants := thread.Turns[turns-1].Assistant
			if len(assistants) > 0 {
				cursor["resumeSessionAt"] = assistants[len(assistants)-1].SourceID
			}
		}
	}
	return cursor
}

func (s *Service) recoverExactLegacyImport(ctx context.Context, db *sql.DB, info schema.Info, plan plannedThread) (ledger.Record, bool, error) {
	first, last, matched, err := exactLegacyEventHistory(ctx, db, plan.legacyPlan)
	if err != nil || !matched {
		return ledger.Record{}, false, err
	}
	checkpointValue, err := checkpoint.ForThread(plan.thread)
	if err != nil {
		return ledger.Record{}, false, err
	}
	checkpointJSON, err := json.Marshal(checkpointValue)
	if err != nil {
		return ledger.Record{}, false, err
	}
	return ledger.Record{
		TargetID: identity.TargetID(s.Paths.DBPath), Source: plan.thread.Source, SourceSessionID: plan.thread.SourceSessionID,
		SourceKey: plan.thread.SourceKey, CurrentSourceKey: plan.thread.SourceKey, ProjectID: plan.projectID,
		ThreadID: plan.threadID, ImportedAt: time.Now().UTC().Format(time.RFC3339Nano), ImporterVersion: "1.0.0",
		Migration: info.Migration, FirstSequence: first, LastSequence: last, Resumable: plan.resumable,
		BackupPath: "", Warnings: planWarnings(plan), IdentitySeed: plan.thread.SourceKey, SourceLeafID: plan.thread.LeafID,
		SourceTitle: plan.thread.Title, Checkpoint: checkpointJSON, IsCanonical: boolPointer(true),
	}, true, nil
}

func exactLegacyEventHistory(ctx context.Context, db *sql.DB, plan legacy.Plan) (int64, int64, bool, error) {
	rows, err := db.QueryContext(ctx, `SELECT sequence,event_id,aggregate_kind,stream_id,event_type,occurred_at,actor_kind,payload_json,metadata_json FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? ORDER BY sequence`, plan.Target.ThreadID)
	if err != nil {
		return 0, 0, false, err
	}
	defer rows.Close()
	type stored struct {
		sequence                                                         int64
		id, aggregate, stream, typ, occurredAt, actor, payload, metadata string
	}
	var actual []stored
	for rows.Next() {
		var row stored
		if err := rows.Scan(&row.sequence, &row.id, &row.aggregate, &row.stream, &row.typ, &row.occurredAt, &row.actor, &row.payload, &row.metadata); err != nil {
			return 0, 0, false, err
		}
		actual = append(actual, row)
	}
	if err := rows.Err(); err != nil {
		return 0, 0, false, err
	}
	if len(actual) == 0 || len(actual) != len(plan.Events) {
		return 0, 0, false, nil
	}
	for i, got := range actual {
		want := plan.Events[i]
		payload, _ := json.Marshal(want.Payload)
		metadata, _ := json.Marshal(want.Metadata)
		if got.id != want.EventID || got.aggregate != want.AggregateKind || got.stream != want.StreamID || got.typ != want.Type || got.occurredAt != want.OccurredAt || got.actor != want.ActorKind || normalizedJSON(got.payload) != string(payload) || normalizedJSON(got.metadata) != string(metadata) {
			return 0, 0, false, nil
		}
	}
	return actual[0].sequence, actual[len(actual)-1].sequence, true, nil
}

func normalizedJSON(raw string) string {
	var value any
	if json.Unmarshal([]byte(raw), &value) != nil {
		return ""
	}
	data, _ := json.Marshal(value)
	return string(data)
}

func summarizeThreads(threads []domain.CanonicalThread) PreviewCounts {
	var counts PreviewCounts
	for _, source := range threads {
		thread := terminalThread(source)
		if len(thread.Turns) == 0 {
			continue
		}
		counts.Tasks++
		counts.Turns += len(thread.Turns)
		if !thread.CurrentBranch {
			counts.Activities++
		}
		for _, turn := range thread.Turns {
			counts.Messages += 1 + len(turn.Assistant)
			counts.Activities += len(turn.Activities)
			counts.Attachments += len(turn.User.Attachments)
		}
	}
	return counts
}

func targetThreadState(ctx context.Context, db *sql.DB, info schema.Info, id string) (exists, deleted bool, err error) {
	if info.Profile == schema.ProfileLegacy {
		var created, tombstones int
		err = db.QueryRowContext(ctx, `SELECT COALESCE(SUM(CASE WHEN event_type='thread.created' THEN 1 ELSE 0 END),0),COALESCE(SUM(CASE WHEN event_type='thread.deleted' THEN 1 ELSE 0 END),0) FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=?`, id).Scan(&created, &tombstones)
		if err != nil {
			return false, false, err
		}
		return created > 0, tombstones > 0, nil
	}
	var deletedAt sql.NullString
	err = db.QueryRowContext(ctx, `SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?`, id).Scan(&deletedAt)
	if err == sql.ErrNoRows {
		return false, false, nil
	}
	return err == nil, deletedAt.Valid, err
}

func threadExists(ctx context.Context, db *sql.DB, info schema.Info, id string) bool {
	exists, deleted, err := targetThreadState(ctx, db, info, id)
	return err == nil && exists && !deleted
}

func targetThreadActive(ctx context.Context, db *sql.DB, info schema.Info, id string) (bool, error) {
	if info.Profile == schema.ProfileLegacy {
		var count int
		err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM provider_session_runtime WHERE thread_id=? AND lower(status) IN ('running','active','starting')`, id).Scan(&count)
		return count > 0, err
	}
	var count int
	err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM orchestration_v2_projection_provider_threads WHERE thread_id=? AND lower(status) IN ('running','active','starting')`, id).Scan(&count)
	return count > 0, err
}

func (s *Service) legacySyncStatus(ctx context.Context, db *sql.DB, state threadAssessment, thread domain.CanonicalThread) (string, int, int, bool, error) {
	if state.record == nil {
		exists, deleted, err := targetThreadState(ctx, db, schema.Info{Profile: schema.ProfileLegacy}, state.plan.threadID)
		if err != nil {
			return "", 0, 0, false, err
		}
		if !exists {
			return "new", len(thread.Turns), 0, false, nil
		}
		if deleted {
			return "target-missing", 0, 0, false, nil
		}
		return "history-diverged", 0, 0, false, nil
	}
	if !state.exists || state.deleted {
		return "target-missing", 0, 0, false, nil
	}
	threadID := state.record.ThreadID
	target := state.plan.legacyPlan.Target
	target.ThreadID = threadID
	provider := state.plan.legacyPlan.Provider
	current, err := checkpoint.ForThread(thread)
	if err != nil {
		return "", 0, 0, false, err
	}
	var saved checkpoint.Stored
	if len(state.record.Checkpoint) > 0 {
		saved, _ = checkpoint.Parse(string(state.record.Checkpoint))
	}
	if saved.Version == 0 {
		bootstrapped, last, bootstrapErr := legacy.BootstrapCheckpoint(ctx, db, thread, target)
		if bootstrapErr != nil {
			return "history-diverged", 0, 0, false, nil
		}
		currentSequence, seqErr := lastThreadSequence(ctx, db, threadID)
		if seqErr != nil {
			return "", 0, 0, false, seqErr
		}
		if currentSequence < last {
			return "history-diverged", 0, 0, false, nil
		}
		currentCheck := checkpoint.CheckpointV2{Version: 2, Turns: bootstrapped.Turns}
		if len(current.Turns) < len(currentCheck.Turns) || !checkpointPrefix(currentCheck, current) {
			return "history-diverged", 0, 0, false, nil
		}
		newTurns := len(current.Turns) - len(currentCheck.Turns)
		return ifPositive(newTurns, "syncable", "up-to-date"), newTurns, 0, false, nil
	}
	if !checkpointCompatibleThread(saved, current, thread) {
		return "history-diverged", 0, 0, false, nil
	}
	newTurns := len(current.Turns) - checkpointTurnCount(saved)
	titleChanged := false
	if thread.Title != state.record.SourceTitle {
		_, titleChanged, err = legacy.PlanTitleUpdate(ctx, db, thread, target, state.record.SourceTitle, provider)
		if err != nil {
			return "", 0, 0, false, err
		}
	}
	if newTurns > 0 || titleChanged {
		return "syncable", newTurns, 0, titleChanged, nil
	}
	last, err := lastThreadSequence(ctx, db, threadID)
	if err != nil {
		return "", 0, 0, false, err
	}
	if last > state.record.LastSequence {
		// SyncAppend decides whether the target suffix is a complete source turn.
		return "syncable", 0, 0, false, nil
	}
	return "up-to-date", 0, 0, false, nil
}

func v2SyncStatus(ctx context.Context, db *sql.DB, state threadAssessment, thread domain.CanonicalThread, attachmentsDir string) (string, int, int, error) {
	if state.record == nil {
		exists, deleted, err := targetThreadState(ctx, db, schema.Info{Profile: schema.ProfileV2}, state.plan.threadID)
		if err != nil {
			return "", 0, 0, err
		}
		if !exists {
			return "new", len(thread.Turns), 0, nil
		}
		if deleted {
			return "target-missing", 0, 0, nil
		}
		return "history-diverged", 0, 0, nil
	}
	if !state.exists || state.deleted {
		return "target-missing", 0, 0, nil
	}
	rows, err := v2.InspectThread(ctx, db, state.record.ThreadID)
	if err != nil {
		return "history-diverged", 0, 0, nil
	}
	full, err := v2PlanForRecord(thread, *state.record, state.plan.provider, attachmentsDir)
	if err != nil {
		return "history-diverged", 0, 0, nil
	}
	if len(state.record.Checkpoint) > 0 {
		saved, valid := checkpoint.Parse(string(state.record.Checkpoint))
		if !valid || !checkpointCompatibleThread(saved, mustCheckpoint(thread), thread) {
			return "history-diverged", 0, 0, nil
		}
		if saved.Version == 2 && saved.V2.NativeProjection != nil {
			match, matchErr := v2.VerifyNativeSync(ctx, db, thread, state.record.IdentitySeed, full, saved, attachmentsDir)
			if matchErr != nil {
				return "history-diverged", 0, 0, nil
			}
			newTurns := max(0, len(thread.Turns)-match.AppendFrom)
			if newTurns > 0 || match.AdoptedTurns > 0 || match.ExistingTurns > 0 {
				return "syncable", newTurns, match.AdoptedTurns, nil
			}
			return "up-to-date", 0, 0, nil
		}
	}
	plan, err := v2.BuildSyncPlan(rows, full)
	if err != nil {
		return "history-diverged", 0, 0, nil
	}
	newTurns := 0
	if len(plan.Events) > 0 {
		newTurns = max(1, len(thread.Turns)-checkpointCount(state.record.Checkpoint))
		return "syncable", newTurns, 0, nil
	}
	if len(state.record.Checkpoint) > 0 && !checkpointCompatibleThread(parseCheckpoint(state.record.Checkpoint), mustCheckpoint(thread), thread) {
		return "history-diverged", 0, 0, nil
	}
	if checkpointCount(state.record.Checkpoint) < len(thread.Turns) {
		// T3 may already contain a complete, exact source suffix from a write
		// whose ledger checkpoint was interrupted. Reconcile the ledger without
		// replaying those events.
		return "syncable", len(thread.Turns) - checkpointCount(state.record.Checkpoint), 0, nil
	}
	return "up-to-date", 0, 0, nil
}

func checkpointCompatiblePrefix(saved checkpoint.Stored, current checkpoint.CheckpointV2) bool {
	switch saved.Version {
	case 1:
		if saved.V1 == nil || len(saved.V1.Turns) > len(current.Turns) {
			return false
		}
		for i, old := range saved.V1.Turns {
			if old.ID != current.Turns[i].ID {
				return false
			}
			// Legacy v1 semantic hashes are compared by checkpointCompatibleThread,
			// which has the corresponding canonical source turns.
		}
		return true
	case 2:
		return saved.V2 != nil && checkpointPrefix(*saved.V2, current)
	default:
		return false
	}
}

func checkpointCompatibleThread(saved checkpoint.Stored, current checkpoint.CheckpointV2, thread domain.CanonicalThread) bool {
	if saved.Version != 1 {
		return checkpointCompatiblePrefix(saved, current)
	}
	if saved.V1 == nil || len(saved.V1.Turns) > len(thread.Turns) {
		return false
	}
	for i, old := range saved.V1.Turns {
		hash, err := checkpoint.LegacyTurnSemanticHash(thread.Turns[i])
		if err != nil || old.ID != thread.Turns[i].ID || old.Hash != hash {
			return false
		}
	}
	return true
}

func checkpointPrefix(saved, current checkpoint.CheckpointV2) bool {
	if len(saved.Turns) > len(current.Turns) {
		return false
	}
	for i, old := range saved.Turns {
		if old.ID != current.Turns[i].ID || old.Status != current.Turns[i].Status || old.Hash != current.Turns[i].Hash || valueOf(old.TerminalReason) != valueOf(current.Turns[i].TerminalReason) || valueOf(old.TerminalError) != valueOf(current.Turns[i].TerminalError) {
			return false
		}
	}
	return true
}

func checkpointTurnCount(saved checkpoint.Stored) int {
	if saved.Version == 1 && saved.V1 != nil {
		return len(saved.V1.Turns)
	}
	if saved.Version == 2 && saved.V2 != nil {
		return len(saved.V2.Turns)
	}
	return 0
}

func checkpointCount(raw json.RawMessage) int {
	return checkpointTurnCount(parseCheckpoint(raw))
}

func parseCheckpoint(raw json.RawMessage) checkpoint.Stored {
	stored, _ := checkpoint.Parse(string(raw))
	return stored
}

func mustCheckpoint(thread domain.CanonicalThread) checkpoint.CheckpointV2 {
	current, _ := checkpoint.ForThread(thread)
	return current
}

func lastThreadSequence(ctx context.Context, db *sql.DB, threadID string) (int64, error) {
	var sequence int64
	err := db.QueryRowContext(ctx, `SELECT COALESCE(MAX(sequence),0) FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=?`, threadID).Scan(&sequence)
	return sequence, err
}

func ifPositive(value int, positive, zero string) string {
	if value > 0 {
		return positive
	}
	return zero
}

func (s *Service) inspectConversation(ctx context.Context, conversation domain.CanonicalConversation, mode Mode, request Request) (PreviewSession, error) {
	db, info, err := openValidatedTarget(ctx, s.Paths, true)
	if err != nil {
		return PreviewSession{}, err
	}
	defer db.Close()
	records, err := s.targetRecords(ctx, conversation.Summary.Source)
	if err != nil {
		return PreviewSession{}, err
	}
	assessment, err := s.assess(ctx, db, info, records, conversation, mode, request.Provider, request.NoResume)
	return assessment.preview, err
}

func ensureCurrentProfile(ctx context.Context, db *sql.DB, expected schema.Info) error {
	actual, err := schema.Validate(ctx, db)
	if err != nil {
		return err
	}
	if actual.Profile != expected.Profile || actual.Migration != expected.Migration {
		return withExitCode(4, errors.New("T3 target profile changed during the operation"))
	}
	return nil
}

func newOutcome(summary domain.SourceSummary, kind domain.OutcomeKind, phase domain.OutcomePhase, code, message, next string) domain.SessionOutcomeRecord {
	return domain.SessionOutcomeRecord{Source: summary.Source, SessionID: stringValue(summary.ID), Workspace: stringValue(summary.Workspace), SourcePath: stringValue(summary.Path), DisplayName: summary.Title, Outcome: domain.SessionOutcome{Kind: kind, Phase: phase, Code: code, Message: message, NextAction: next}}
}

func timestampNow() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func hasInProgress(thread domain.CanonicalThread) bool {
	for _, turn := range thread.Turns {
		if turn.Status == domain.TurnInProgress {
			return true
		}
	}
	return false
}
