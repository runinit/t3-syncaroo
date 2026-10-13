package v2

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"

	"github.com/runinit/t3-syncaroo/internal/checkpoint"
	"github.com/runinit/t3-syncaroo/internal/domain"
)

// NativeSyncMatch describes the first source turn that is not already present
// in the target and how many turns T3 completed natively after the saved
// checkpoint. Existing and native turns are both safe to checkpoint without
// replaying their T3 history.
type NativeSyncMatch struct {
	AppendFrom         int
	AdoptedTurns       int
	ExistingTurns      int
	Projection         *checkpoint.NativeProjectionIdentityV1
	SupplementalEvents []Event
}

// deriveVerifiedCheckpointItemIDs accepts operational checkpoint rows only
// when the checkpoint is joined through its scope, run, attempt, node, and the
// already source-matched provider turn. A checkpoint item on its own is never
// enough evidence to ignore it during transcript comparison.
func deriveVerifiedCheckpointItemIDs(projection BuiltinProjection, checkpoints []map[string]any, provider map[string]any, source domain.CanonicalThread, sourceNativeTurnID, providerTurnID string) []string {
	if len(checkpoints) == 0 {
		return []string{}
	}
	threadID := valueString(projection.Thread["id"])
	providerThreadID := valueString(provider["id"])
	providerInstanceID := valueString(provider["providerInstanceId"])
	driver := driverFor(source)
	verified := make([]string, 0, len(checkpoints))
	for _, item := range checkpoints {
		itemID := valueString(item["id"])
		runID := valueString(item["runId"])
		nodeID := valueString(item["nodeId"])
		checkpointID := valueString(item["checkpointId"])
		scopeID := valueString(item["scopeId"])
		if item["threadId"] != threadID || item["status"] != "completed" || item["providerThreadId"] != providerThreadID || itemID == "" || runID == "" || nodeID == "" || checkpointID == "" || scopeID == "" {
			return nil
		}
		checkpoint := exactlyOneMap(projection.Checkpoints, func(row map[string]any) bool { return row["id"] == checkpointID && row["threadId"] == threadID })
		if checkpoint == nil || checkpoint["scopeId"] != scopeID || checkpoint["runId"] != runID || checkpoint["nodeId"] != nodeID || (checkpoint["status"] != "ready" && checkpoint["status"] != "missing") || integerValue(checkpoint["appRunOrdinal"]) < 1 || !reflect.DeepEqual(checkpoint["files"], item["files"]) {
			return nil
		}
		scope := exactlyOneMap(projection.CheckpointScopes, func(row map[string]any) bool {
			return row["id"] == checkpoint["scopeId"] && row["threadId"] == threadID
		})
		if scope == nil {
			return nil
		}
		run := exactlyOneMap(projection.Runs, func(row map[string]any) bool { return row["id"] == runID && row["threadId"] == threadID })
		if run == nil || run["status"] != "completed" || run["providerInstanceId"] != providerInstanceID || run["providerThreadId"] != providerThreadID || run["rootNodeId"] != nodeID || run["checkpointId"] != checkpoint["id"] || integerValue(run["ordinal"]) != integerValue(checkpoint["appRunOrdinal"]) || valueString(run["activeAttemptId"]) == "" {
			return nil
		}
		scopeRun := exactlyOneMap(projection.Runs, func(row map[string]any) bool { return row["id"] == scope["runId"] && row["threadId"] == threadID })
		scopeNode := exactlyOneMap(projection.Nodes, func(row map[string]any) bool { return row["id"] == scope["nodeId"] && row["threadId"] == threadID })
		if scopeRun == nil || scopeRun["status"] != "completed" || scopeRun["providerThreadId"] != providerThreadID || scopeRun["providerInstanceId"] != providerInstanceID || integerValue(scopeRun["ordinal"]) < integerValue(run["ordinal"]) || scopeRun["rootNodeId"] != scope["nodeId"] || scopeNode == nil || scopeNode["runId"] != scopeRun["id"] || scopeNode["kind"] != "root_turn" || scopeNode["status"] != "completed" || scopeNode["checkpointScopeId"] != scope["id"] || scopeNode["providerThreadId"] != providerThreadID || scope["providerThreadId"] != providerThreadID || scope["kind"] != "root_run" || scope["advancesAppRunCount"] != true {
			return nil
		}
		attempt := exactlyOneMap(projection.RunAttempts, func(row map[string]any) bool {
			return row["id"] == run["activeAttemptId"] && row["runId"] == run["id"] && row["threadId"] == threadID
		})
		if attempt == nil || attempt["status"] != "completed" || attempt["rootNodeId"] != run["rootNodeId"] || attempt["providerInstanceId"] != providerInstanceID || attempt["providerThreadId"] != providerThreadID {
			return nil
		}
		node := exactlyOneMap(projection.Nodes, func(row map[string]any) bool {
			return row["id"] == run["rootNodeId"] && row["runId"] == run["id"] && row["threadId"] == threadID
		})
		if node == nil || node["kind"] != "root_turn" || node["status"] != "completed" || node["providerThreadId"] != providerThreadID || node["checkpointScopeId"] != checkpoint["scopeId"] {
			return nil
		}
		providerTurn := exactlyOneMap(projection.ProviderTurns, func(row map[string]any) bool { return row["runAttemptId"] == attempt["id"] })
		if providerTurn == nil || providerTurn["threadId"] != nil && providerTurn["threadId"] != threadID || providerTurn["id"] != providerTurnID || providerTurn["providerThreadId"] != providerThreadID || providerTurn["nodeId"] != node["id"] || providerTurn["status"] != "completed" {
			return nil
		}
		ref, _ := providerTurn["nativeTurnRef"].(map[string]any)
		strength := valueString(ref["strength"])
		if ref == nil || ref["driver"] != driver || ref["nativeId"] != sourceNativeTurnID || source.Source == domain.SourceCodex && strength != "strong" || source.Source == domain.SourceClaude && strength != "weak" && strength != "strong" {
			return nil
		}
		for _, field := range []string{"providerTurnId"} {
			for _, row := range []map[string]any{item, attempt, node} {
				if value, exists := row[field]; exists && value != nil && value != providerTurnID {
					return nil
				}
			}
		}
		verified = append(verified, itemID)
	}
	return verified
}

func exactlyOneMap(rows []map[string]any, predicate func(map[string]any) bool) map[string]any {
	var found map[string]any
	count := 0
	for _, row := range rows {
		if predicate(row) {
			found = row
			count++
		}
	}
	if count != 1 {
		return nil
	}
	return found
}

func integerValue(value any) int64 {
	switch number := value.(type) {
	case int:
		return int64(number)
	case int32:
		return int64(number)
	case int64:
		return number
	case float64:
		if number == float64(int64(number)) {
			return int64(number)
		}
	}
	return 0
}

func deliveredUserText(projection BuiltinProjection, provider map[string]any, runID any, sourceText, actualText string) bool {
	providerID := valueString(provider["id"])
	nativeRef, _ := provider["nativeThreadRef"].(map[string]any)
	nativeThreadID := valueString(nativeRef["nativeId"])
	var candidates []map[string]any
	for _, handoff := range projection.ContextHandoffs {
		delivery, _ := handoff["delivery"].(map[string]any)
		if handoff["threadId"] == projection.Thread["id"] && handoff["targetRunId"] == runID && handoff["toProviderThreadId"] == providerID && handoff["status"] == "ready" && delivery["status"] == "inline" && delivery["nativeThreadId"] == nativeThreadID {
			candidates = append(candidates, handoff)
		}
	}
	if len(candidates) != 1 {
		return false
	}
	handoff := candidates[0]
	delivery, _ := handoff["delivery"].(map[string]any)
	history, _ := handoff["history"].(map[string]any)
	coverage, coverageOK := history["coverage"].(string)
	historyMessages, messagesOK := history["messages"].([]any)
	itemIDs, itemIDsOK := delivery["itemIds"].([]any)
	if history == nil || !coverageOK || coverage == "" || !messagesOK || !itemIDsOK {
		return false
	}
	if _, ok := delivery["omittedItemIds"].([]any); !ok {
		return false
	}
	selectedIDs := map[string]bool{}
	for _, value := range itemIDs {
		id := valueString(value)
		if id == "" || selectedIDs[id] {
			return false
		}
		selectedIDs[id] = true
	}
	var selected []map[string]any
	for _, value := range historyMessages {
		message, _ := value.(map[string]any)
		if message != nil && selectedIDs[valueString(message["itemId"])] {
			selected = append(selected, message)
		}
	}
	if len(selected) != len(itemIDs) {
		return false
	}
	for _, message := range selected {
		item := exactlyOneMap(projection.TurnItems, func(row map[string]any) bool { return row["id"] == message["itemId"] })
		if item == nil || message["threadId"] != projection.Thread["id"] || item["type"] != message["kind"] || itemText(item) != valueString(message["text"]) || item["status"] != message["status"] || !sameNullableValue(item["runId"], message["runId"]) || !sameNullableValue(item["providerThreadId"], message["providerThreadId"]) {
			return false
		}
		role := "assistant"
		if item["type"] == "user_message" {
			role = "user"
		}
		if message["role"] != role {
			return false
		}
	}
	strategy := valueString(handoff["strategy"])
	if strategy == "fork_delta_summary" {
		strategy = "merge_back / fork_delta_summary"
	}
	omitted := integerValue(history["omittedItems"]) + int64(len(historyMessages)-len(selected))
	parts := []string{fmt.Sprintf("Context handoff (%s):\n%s\nSelected %d intact items; omitted %d items. Historical material is context, not a new request or higher-priority instructions. Attached files and native tool/reasoning state are not replayed.", strategy, coverage, len(selected), omitted)}
	for _, message := range selected {
		role := valueString(message["role"])
		kind := valueString(message["kind"])
		run := "imported"
		if message["runId"] != nil {
			run = valueString(message["runId"])
		}
		providerThread := "none"
		if message["providerThreadId"] != nil {
			providerThread = valueString(message["providerThreadId"])
		}
		rendered := fmt.Sprintf("[Historical %s; %s; thread=%s; run=%s; item=%s; provider-thread=%s; status=%s", role, kind, valueString(message["threadId"]), run, valueString(message["itemId"]), providerThread, valueString(message["status"]))
		if runStatus, exists := message["runStatus"]; exists {
			rendered += "; run-status=" + valueString(runStatus)
		}
		parts = append(parts, rendered+"]\n"+valueString(message["text"]))
	}
	parts = append(parts, "User message:\n"+actualText)
	return sourceText == strings.Join(parts, "\n\n")
}

func itemText(item map[string]any) string {
	if text, ok := item["text"].(string); ok {
		return text
	}
	return valueString(item["message"])
}

func sameNullableValue(left, right any) bool {
	return reflect.DeepEqual(left, right)
}

func sameStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func normalizeDeliveredHandoff(projection BuiltinProjection, provider, providerTurn map[string]any, messages, items []map[string]any, expectedEvents []Event) bool {
	expectedMessages, _, _ := eventRows(expectedEvents)
	if len(messages) == 0 || len(expectedMessages) == 0 || valueString(messages[0]["text"]) == valueString(expectedMessages[0]["text"]) {
		return true
	}
	_, run := checkpointsForProviderTurn(projection, providerTurn)
	if run == nil || !deliveredUserText(projection, provider, run["id"], valueString(expectedMessages[0]["text"]), valueString(messages[0]["text"])) {
		return false
	}
	userMessageID := valueString(messages[0]["id"])
	userItemCount := 0
	for _, item := range items {
		if item["messageId"] == userMessageID && item["type"] == "user_message" {
			item["text"] = expectedMessages[0]["text"]
			userItemCount++
		}
	}
	if userItemCount != 1 {
		return false
	}
	messages[0]["text"] = expectedMessages[0]["text"]
	return true
}

func partitionNativeUsageItems(items []map[string]any, usageByID map[string]Event) ([]map[string]any, map[string]map[string]any, bool) {
	ordinary := make([]map[string]any, 0, len(items))
	usage := make(map[string]map[string]any, len(usageByID))
	for _, item := range items {
		id := valueString(item["id"])
		if _, isUsage := usageByID[id]; !isUsage {
			ordinary = append(ordinary, item)
			continue
		}
		if _, duplicate := usage[id]; duplicate {
			return nil, nil, false
		}
		usage[id] = item
	}
	return ordinary, usage, true
}

func validNativeUsageItem(actual map[string]any, expected Event, provider, providerTurn, run map[string]any) bool {
	want := eventPayload(expected)
	ignored := []string{"id", "threadId", "ordinal", "runId", "nodeId", "providerThreadId", "providerTurnId", "nativeItemRef", "parentItemId", "creationSource", "startedAt", "completedAt", "updatedAt"}
	if !semanticMapEqual(actual, want, ignored...) {
		return false
	}
	for field, expectedValue := range map[string]any{"providerThreadId": provider["id"], "providerTurnId": providerTurn["id"]} {
		if actual[field] != nil && actual[field] != expectedValue {
			return false
		}
	}
	if run != nil && actual["runId"] != nil && actual["runId"] != run["id"] {
		return false
	}
	return true
}

// VerifyNativeSync proves that the saved imported prefix is still present and
// that each later T3 native continuation corresponds to an exact source turn.
// It is read-only; callers use AppendFrom to plan any source-only suffix.
func VerifyNativeSync(ctx context.Context, db *sql.DB, thread domain.CanonicalThread, identitySeed string, full Plan, saved checkpoint.Stored, attachmentsDir string) (NativeSyncMatch, error) {
	if saved.Version != 2 || saved.V2 == nil || saved.V2.NativeProjection == nil {
		return NativeSyncMatch{}, errors.New("v2: native sync requires a verified v2 projection checkpoint")
	}
	if identitySeed == "" || full.ThreadID == "" || full.ProjectID == "" || full.ProviderInstanceID == "" {
		return NativeSyncMatch{}, errors.New("v2: native sync requires stable source and target identities")
	}
	thread.SourceKey = identitySeed
	prefixCount := len(saved.V2.Turns)
	if prefixCount == 0 || prefixCount > len(thread.Turns) {
		return NativeSyncMatch{}, errors.New("v2: native sync checkpoint is not a source prefix")
	}
	projection, err := InspectBuiltinProjection(ctx, db, full.ThreadID)
	if err != nil {
		return NativeSyncMatch{}, err
	}
	provider, err := exactProviderBinding(projection, thread, full)
	if err != nil {
		return NativeSyncMatch{}, err
	}
	prefixThread := thread
	prefixThread.Turns = append([]domain.CanonicalTurn(nil), thread.Turns[:prefixCount]...)
	prefixPlan, err := BuildPlanWithRuntimeOptions(prefixThread, full.ThreadID, full.ProjectID, full.ProviderInstanceID, thread.Model, map[string]any{}, false, attachmentsDir, false)
	if err != nil {
		return NativeSyncMatch{}, err
	}
	identity := saved.V2.NativeProjection
	prefixMessages, prefixItems, prefixPlans := eventRows(prefixPlan.Events)
	if len(identity.Messages) != len(prefixMessages) || len(identity.TurnItems) != len(prefixItems) || len(identity.Plans) != len(prefixPlans) {
		return NativeSyncMatch{}, errors.New("v2: saved native projection does not cover the complete source checkpoint")
	}
	prefixTargetMessages, _, ok := rowsForProjectionIDs(projection.Messages, identity.Messages)
	if !ok {
		return NativeSyncMatch{}, errors.New("v2: target changed or removed saved native message identities")
	}
	prefixTargetItems, _, ok := rowsForProjectionIDs(projection.TurnItems, identity.TurnItems)
	if !ok {
		return NativeSyncMatch{}, errors.New("v2: target changed or removed saved native turn-item identities")
	}
	prefixTargetPlans, _, ok := rowsForProjectionIDs(projection.Plans, identity.Plans)
	if !ok {
		return NativeSyncMatch{}, errors.New("v2: target changed or removed saved native plan identities")
	}
	if !projectionBindingsEqual(prefixTargetItems, identity.TurnItemBindings) {
		return NativeSyncMatch{}, errors.New("v2: target changed the saved native item lineage")
	}
	if !semanticRowsMatch(prefixTargetMessages, prefixTargetItems, prefixTargetPlans, prefixPlan.Events, true) {
		return NativeSyncMatch{}, errors.New("v2: target changed the saved source history")
	}
	providerTurns := identity.ProviderTurns
	var savedProviderIDs []string
	if providerTurns != nil {
		savedProviderIDs = *providerTurns
	} else if len(projection.ProviderTurns) > 0 {
		return NativeSyncMatch{}, errors.New("v2: target has native provider turns without a saved source checkpoint")
	}
	if len(projection.ProviderTurns) < len(savedProviderIDs) {
		return NativeSyncMatch{}, errors.New("v2: target is missing a previously verified native provider turn")
	}
	for i, id := range savedProviderIDs {
		if projection.ProviderTurns[i]["id"] != id {
			return NativeSyncMatch{}, errors.New("v2: target reordered or replaced a verified native provider turn")
		}
	}
	turnsByProviderID, err := matchProviderTurns(projection.ProviderTurns, thread, provider)
	if err != nil {
		return NativeSyncMatch{}, err
	}
	for _, id := range savedProviderIDs {
		turn, ok := turnsByProviderID[id]
		if !ok || turn["_sourceIndex"].(int) >= prefixCount {
			return NativeSyncMatch{}, errors.New("v2: saved provider-turn lineage no longer matches the source checkpoint")
		}
	}
	eventsByID := make(map[string]Event, len(projection.Events))
	for _, row := range projection.Events {
		eventsByID[row.Event.ID] = row.Event
	}
	messageCursor, itemCursor, planCursor := 0, 0, 0
	for turnIndex := 0; turnIndex < prefixCount; turnIndex++ {
		turnEvents, planErr := planSourceTurn(thread, turnIndex, full, attachmentsDir)
		if planErr != nil {
			return NativeSyncMatch{}, planErr
		}
		providerTurn := providerTurnForSource(turnsByProviderID, turnIndex)
		expectedEvents := turnEvents
		if providerTurn != nil {
			expectedEvents, planErr = nativeExpectedTurnEvents(thread, thread.Turns[turnIndex], turnEvents)
			if planErr != nil {
				return NativeSyncMatch{}, planErr
			}
		}
		expectedMessages, expectedItems, expectedPlans := eventRows(expectedEvents)
		if messageCursor+len(expectedMessages) > len(prefixTargetMessages) || itemCursor+len(expectedItems) > len(prefixTargetItems) || planCursor+len(expectedPlans) > len(prefixTargetPlans) {
			return NativeSyncMatch{}, errors.New("v2: saved source prefix contains a partial turn")
		}
		actualMessages := prefixTargetMessages[messageCursor : messageCursor+len(expectedMessages)]
		actualItems := prefixTargetItems[itemCursor : itemCursor+len(expectedItems)]
		actualPlans := prefixTargetPlans[planCursor : planCursor+len(expectedPlans)]
		if providerTurn == nil {
			if !segmentHasImporterIDs(actualMessages, actualItems, actualPlans, expectedMessages, expectedItems, expectedPlans) || !semanticRowsMatch(actualMessages, actualItems, actualPlans, turnEvents, false) || !eventsExactlyPresent(eventsByID, turnEvents) {
				return NativeSyncMatch{}, errors.New("v2: saved importer-owned source turn changed")
			}
		} else {
			checkpoints, run := checkpointsForProviderTurn(projection, providerTurn)
			nativeID, _ := sourceNativeTurnID(thread.Source, thread.Turns[turnIndex])
			verified := deriveVerifiedCheckpointItemIDs(projection, checkpoints, provider, thread, nativeID, fmt.Sprint(providerTurn["id"]))
			if verified == nil || len(verified) != len(checkpoints) {
				return NativeSyncMatch{}, errors.New("v2: saved native checkpoint has incomplete or mismatched provenance")
			}
			usageByID := make(map[string]Event)
			for _, event := range sourceUsageEvents(expectedEvents, thread.Source) {
				usageByID[valueString(eventPayload(event)["id"])] = event
			}
			nativeItems, checkpointItems := nativeTurnItems(projection, providerTurn, actualMessages, run, usageByID)
			ordinaryItems, usageItems, partitionOK := partitionNativeUsageItems(nativeItems, usageByID)
			if !partitionOK || !sameItemIDs(checkpoints, checkpointItems) || !normalizeDeliveredHandoff(projection, provider, providerTurn, actualMessages, nativeItems, expectedEvents) || len(ordinaryItems) == 0 {
				return NativeSyncMatch{}, errors.New("v2: saved native turn has ambiguous items or inline context")
			}
			usageIDs := make(map[string]bool, len(usageByID))
			for id := range usageByID {
				usageIDs[id] = true
			}
			if err := verifyNativeTurnSegment(actualMessages, ordinaryItems, actualPlans, excludeUsageEvents(expectedEvents, usageIDs), thread.Turns[turnIndex], providerTurn, provider, thread.Source); err != nil {
				return NativeSyncMatch{}, err
			}
			for id, item := range usageItems {
				if !validNativeUsageItem(item, usageByID[id], provider, providerTurn, run) {
					return NativeSyncMatch{}, errors.New("v2: saved native usage notice differs from the source")
				}
			}
			nativeItemIDs := make([]string, 0, len(expectedItems))
			ordinaryIndex := 0
			for _, expected := range expectedItems {
				id := valueString(expected["id"])
				if _, usage := usageByID[id]; usage {
					if usageItems[id] == nil {
						return NativeSyncMatch{}, errors.New("v2: saved native prefix is missing a source usage notice")
					}
					nativeItemIDs = append(nativeItemIDs, id)
					continue
				}
				if ordinaryIndex >= len(ordinaryItems) {
					return NativeSyncMatch{}, errors.New("v2: saved native prefix has an incomplete item sequence")
				}
				nativeItemIDs = append(nativeItemIDs, valueString(ordinaryItems[ordinaryIndex]["id"]))
				ordinaryIndex++
			}
			if ordinaryIndex != len(ordinaryItems) || !sameStrings(projectionIDs(actualItems), nativeItemIDs) {
				return NativeSyncMatch{}, errors.New("v2: saved native item identities no longer match their verified turn")
			}
		}
		messageCursor += len(expectedMessages)
		itemCursor += len(expectedItems)
		planCursor += len(expectedPlans)
	}
	if provider["nativeThreadRef"] == nil && len(projection.ProviderTurns) > len(savedProviderIDs) {
		return NativeSyncMatch{}, errors.New("v2: native provider turns cannot be adopted without a source-session binding")
	}
	match := NativeSyncMatch{AppendFrom: prefixCount}
	messageOffset, planOffset := len(prefixMessages), len(prefixPlans)
	verifiedCheckpointIDs := map[string]bool{}
	consumedItemIDs := map[string]bool{}
	for _, id := range identity.TurnItems {
		consumedItemIDs[id] = true
	}
	normalizedProjection := projection
	normalizedProjection.Messages = append([]map[string]any(nil), prefixTargetMessages...)
	normalizedProjection.TurnItems = append([]map[string]any(nil), prefixTargetItems...)
	normalizedProjection.Plans = append([]map[string]any(nil), prefixTargetPlans...)
	normalizedProjection.ProviderTurns = nil
	for turnIndex := 0; turnIndex < prefixCount; turnIndex++ {
		providerTurn := providerTurnForSource(turnsByProviderID, turnIndex)
		if providerTurn == nil {
			continue
		}
		checkpoints, run := checkpointsForProviderTurn(projection, providerTurn)
		if len(checkpoints) == 0 {
			continue
		}
		nativeID, _ := sourceNativeTurnID(thread.Source, thread.Turns[turnIndex])
		verified := deriveVerifiedCheckpointItemIDs(projection, checkpoints, provider, thread, nativeID, fmt.Sprint(providerTurn["id"]))
		if verified == nil || len(verified) != len(checkpoints) {
			return NativeSyncMatch{}, errors.New("v2: native checkpoint item has incomplete or mismatched operational provenance")
		}
		for _, id := range verified {
			verifiedCheckpointIDs[id] = true
			consumedItemIDs[id] = true
		}
		for _, item := range checkpoints {
			if run == nil || item["runId"] != run["id"] {
				return NativeSyncMatch{}, errors.New("v2: native checkpoint belongs to a different run")
			}
		}
	}
	providerTurnIDs := map[string]bool{}
	for turnIndex := prefixCount; turnIndex < len(thread.Turns); turnIndex++ {
		turnPlan, err := planSourceTurn(thread, turnIndex, full, attachmentsDir)
		if err != nil {
			return NativeSyncMatch{}, err
		}
		providerTurn := providerTurnForSource(turnsByProviderID, turnIndex)
		expectedEvents := turnPlan
		if providerTurn != nil {
			expectedEvents, err = nativeExpectedTurnEvents(thread, thread.Turns[turnIndex], turnPlan)
			if err != nil {
				return NativeSyncMatch{}, err
			}
		}
		expectedMessages, expectedItems, expectedPlans := eventRows(expectedEvents)
		remainingMessages := len(projection.Messages) - messageOffset
		remainingPlans := len(projection.Plans) - planOffset
		if remainingMessages == 0 && remainingPlans == 0 && providerTurn == nil {
			match.AppendFrom = turnIndex
			break
		}
		if remainingMessages < len(expectedMessages) || remainingPlans < len(expectedPlans) {
			return NativeSyncMatch{}, errors.New("v2: target contains a partial source or native turn")
		}
		actualMessages := projection.Messages[messageOffset : messageOffset+len(expectedMessages)]
		actualPlans := projection.Plans[planOffset : planOffset+len(expectedPlans)]
		itemIDs := projectionIDs(expectedItems)
		actualItems, _, importerItemsPresent := rowsForProjectionIDs(projection.TurnItems, itemIDs)
		if importerItemsPresent && segmentHasImporterIDs(actualMessages, actualItems, actualPlans, expectedMessages, expectedItems, expectedPlans) {
			if !semanticRowsMatch(actualMessages, actualItems, actualPlans, turnPlan, false) || !eventsExactlyPresent(eventsByID, turnPlan) {
				return NativeSyncMatch{}, errors.New("v2: target importer-owned turn differs from its source history")
			}
			match.ExistingTurns++
			for _, item := range actualItems {
				consumedItemIDs[valueString(item["id"])] = true
				normalizedProjection.TurnItems = append(normalizedProjection.TurnItems, item)
			}
		} else {
			if providerTurn == nil {
				return NativeSyncMatch{}, errors.New("v2: target contains an unowned or ambiguous continuation")
			}
			checkpoints, run := checkpointsForProviderTurn(projection, providerTurn)
			nativeID, _ := sourceNativeTurnID(thread.Source, thread.Turns[turnIndex])
			verifiedCheckpoints := deriveVerifiedCheckpointItemIDs(projection, checkpoints, provider, thread, nativeID, fmt.Sprint(providerTurn["id"]))
			if verifiedCheckpoints == nil || len(verifiedCheckpoints) != len(checkpoints) {
				return NativeSyncMatch{}, errors.New("v2: native checkpoint item has incomplete or mismatched operational provenance")
			}
			for _, id := range verifiedCheckpoints {
				verifiedCheckpointIDs[id] = true
				consumedItemIDs[id] = true
			}
			if run != nil {
				for _, item := range checkpoints {
					if item["runId"] != run["id"] {
						return NativeSyncMatch{}, errors.New("v2: native checkpoint belongs to a different run")
					}
				}
			}
			usageEvents := sourceUsageEvents(expectedEvents, thread.Source)
			usageByID := make(map[string]Event, len(usageEvents))
			for _, event := range usageEvents {
				payload := eventPayload(event)
				usageByID[valueString(payload["id"])] = event
			}
			nativeItems, checkpointItems := nativeTurnItems(projection, providerTurn, actualMessages, run, usageByID)
			if !sameItemIDs(checkpoints, checkpointItems) {
				return NativeSyncMatch{}, errors.New("v2: native checkpoint ordering or ownership is ambiguous")
			}
			ordinaryItems, usageItems, partitionOK := partitionNativeUsageItems(nativeItems, usageByID)
			if !partitionOK {
				return NativeSyncMatch{}, errors.New("v2: native continuation contains duplicate source usage notices")
			}
			missingUsage := make(map[string]bool, len(usageEvents))
			usageIDs := make(map[string]bool, len(usageEvents))
			for _, event := range usageEvents {
				id := valueString(eventPayload(event)["id"])
				usageIDs[id] = true
				if usageItems[id] == nil {
					missingUsage[id] = true
				} else if !validNativeUsageItem(usageItems[id], event, provider, providerTurn, run) {
					return NativeSyncMatch{}, errors.New("v2: native usage notice differs from the source")
				}
			}
			verifyEvents := excludeUsageEvents(expectedEvents, usageIDs)
			if !normalizeDeliveredHandoff(projection, provider, providerTurn, actualMessages, nativeItems, verifyEvents) {
				return NativeSyncMatch{}, errors.New("v2: native inline context handoff does not match its recorded historical items")
			}
			if err := verifyNativeTurnSegment(actualMessages, ordinaryItems, actualPlans, verifyEvents, thread.Turns[turnIndex], providerTurn, provider, thread.Source); err != nil {
				return NativeSyncMatch{}, err
			}
			for _, event := range usageEvents {
				payload := eventPayload(event)
				id := valueString(payload["id"])
				if !missingUsage[id] {
					continue
				}
				payload["providerThreadId"] = provider["id"]
				payload["providerTurnId"] = providerTurn["id"]
				payload["runId"] = nil
				if run != nil {
					payload["runId"] = run["id"]
				}
				payload["nodeId"] = providerTurn["nodeId"]
				encoded, marshalErr := json.Marshal(payload)
				if marshalErr != nil {
					return NativeSyncMatch{}, marshalErr
				}
				event.Payload = encoded
				match.SupplementalEvents = append(match.SupplementalEvents, event)
			}
			providerTurnIDs[fmt.Sprint(providerTurn["id"])] = true
			match.AdoptedTurns++
			ordinaryIndex := 0
			for _, item := range expectedItems {
				id := valueString(item["id"])
				if _, isUsage := usageByID[id]; isUsage {
					if actual, found := usageItems[id]; found {
						normalizedProjection.TurnItems = append(normalizedProjection.TurnItems, actual)
						consumedItemIDs[id] = true
						continue
					}
					payload := cloneMap(item)
					payload["providerThreadId"] = provider["id"]
					payload["providerTurnId"] = providerTurn["id"]
					payload["runId"] = nil
					if run != nil {
						payload["runId"] = run["id"]
					}
					payload["nodeId"] = providerTurn["nodeId"]
					normalizedProjection.TurnItems = append(normalizedProjection.TurnItems, payload)
					continue
				}
				if ordinaryIndex >= len(ordinaryItems) {
					return NativeSyncMatch{}, errors.New("v2: native continuation item sequence is incomplete")
				}
				normalizedProjection.TurnItems = append(normalizedProjection.TurnItems, ordinaryItems[ordinaryIndex])
				ordinaryIndex++
			}
			if ordinaryIndex != len(ordinaryItems) {
				return NativeSyncMatch{}, errors.New("v2: native continuation contains extra turn items")
			}
			for _, item := range nativeItems {
				consumedItemIDs[valueString(item["id"])] = true
			}
		}
		normalizedProjection.Messages = append(normalizedProjection.Messages, actualMessages...)
		normalizedProjection.Plans = append(normalizedProjection.Plans, actualPlans...)
		messageOffset += len(expectedMessages)
		planOffset += len(expectedPlans)
		match.AppendFrom = turnIndex + 1
	}
	if messageOffset != len(projection.Messages) || planOffset != len(projection.Plans) {
		return NativeSyncMatch{}, errors.New("v2: target contains unrecognized history after the source checkpoint")
	}
	if len(providerTurnIDs) != len(projection.ProviderTurns)-len(savedProviderIDs) {
		return NativeSyncMatch{}, errors.New("v2: target contains a native provider turn outside the verified source suffix")
	}
	for _, item := range projection.TurnItems {
		id := valueString(item["id"])
		if item["type"] == "checkpoint" && !verifiedCheckpointIDs[id] {
			return NativeSyncMatch{}, errors.New("v2: target contains a checkpoint item without verified native provenance")
		}
		if !consumedItemIDs[id] {
			return NativeSyncMatch{}, errors.New("v2: target contains unrecognized history after the source checkpoint")
		}
	}
	for _, turn := range projection.ProviderTurns[len(savedProviderIDs):] {
		if !providerTurnIDs[fmt.Sprint(turn["id"])] {
			return NativeSyncMatch{}, errors.New("v2: native provider-turn order differs from the source continuation")
		}
	}
	for _, turn := range projection.ProviderTurns {
		normalizedProjection.ProviderTurns = append(normalizedProjection.ProviderTurns, turn)
	}
	captured, err := CaptureBuiltinProjectionIdentity(normalizedProjection)
	if err != nil {
		return NativeSyncMatch{}, err
	}
	match.Projection = captured
	return match, nil
}

// NativeSyncEvents returns the deterministic importer events for source turns
// after start. It omits thread creation and provider binding events because a
// native T3 task already owns both records.
func NativeSyncEvents(thread domain.CanonicalThread, identitySeed string, full Plan, start int, attachmentsDir string) ([]Event, error) {
	if start < 0 || start > len(thread.Turns) {
		return nil, errors.New("v2: invalid native sync source offset")
	}
	if identitySeed == "" {
		return nil, errors.New("v2: native sync requires a stable source identity")
	}
	thread.SourceKey = identitySeed
	var events []Event
	for index := start; index < len(thread.Turns); index++ {
		turnEvents, err := planSourceTurn(thread, index, full, attachmentsDir)
		if err != nil {
			return nil, err
		}
		events = append(events, turnEvents...)
	}
	return events, nil
}

func exactProviderBinding(projection BuiltinProjection, thread domain.CanonicalThread, plan Plan) (map[string]any, error) {
	if projection.Thread["id"] != plan.ThreadID || projection.Thread["projectId"] != plan.ProjectID || projection.Thread["historyOrigin"] != "v1_import" || projection.Thread["providerInstanceId"] != plan.ProviderInstanceID {
		return nil, errors.New("v2: task ownership changed after native import")
	}
	activeID, _ := projection.Thread["activeProviderThreadId"].(string)
	if activeID == "" {
		return nil, errors.New("v2: native task has a missing or ambiguous provider binding")
	}
	var activeProviders []map[string]any
	for _, candidate := range projection.ProviderThreads {
		if candidate["id"] == activeID && candidate["appThreadId"] == plan.ThreadID {
			activeProviders = append(activeProviders, candidate)
		}
	}
	if len(activeProviders) != 1 {
		return nil, errors.New("v2: native task has a missing or ambiguous active provider binding")
	}
	provider := activeProviders[0]
	driver := driverFor(thread)
	if provider["id"] != activeID || provider["appThreadId"] != plan.ThreadID || provider["driver"] != driver || provider["providerInstanceId"] != plan.ProviderInstanceID {
		return nil, errors.New("v2: native provider binding no longer belongs to this source")
	}
	var expected map[string]any
	for _, event := range plan.Events {
		if event.Type == "provider-thread.updated" {
			if err := json.Unmarshal(event.Payload, &expected); err != nil {
				return nil, err
			}
			break
		}
	}
	if expected == nil || !reflect.DeepEqual(provider["nativeThreadRef"], expected["nativeThreadRef"]) {
		return nil, errors.New("v2: native provider binding changed source-session identity")
	}
	if thread.Source == domain.SourceClaude {
		head, _ := provider["nativeConversationHeadRef"].(map[string]any)
		if head != nil {
			current, _ := thread.ResumeCursor["resumeSessionAt"].(string)
			if head["driver"] != driver || head["strength"] != "strong" || current == "" || head["nativeId"] != current {
				return nil, errors.New("v2: Claude native conversation head differs from the selected source branch")
			}
		}
	} else if provider["nativeConversationHeadRef"] != nil {
		return nil, errors.New("v2: Codex native binding has an unexpected conversation head")
	}
	return provider, nil
}

func matchProviderTurns(providerTurns []map[string]any, thread domain.CanonicalThread, provider map[string]any) (map[string]map[string]any, error) {
	result := make(map[string]map[string]any, len(providerTurns))
	lastSourceIndex := -1
	for _, nativeTurn := range providerTurns {
		id, _ := nativeTurn["id"].(string)
		ref, _ := nativeTurn["nativeTurnRef"].(map[string]any)
		driver := driverFor(thread)
		matches := []int{}
		for index, sourceTurn := range thread.Turns {
			nativeID, ok := sourceNativeTurnID(thread.Source, sourceTurn)
			if !ok || ref["driver"] != driver || ref["nativeId"] != nativeID || nativeTurn["providerThreadId"] != provider["id"] || nativeTurn["status"] != string(sourceTurn.Status) {
				continue
			}
			strength, _ := ref["strength"].(string)
			if thread.Source == domain.SourceCodex && strength != "strong" || thread.Source == domain.SourceClaude && strength != "strong" && strength != "weak" {
				continue
			}
			matches = append(matches, index)
		}
		if id == "" || len(matches) != 1 || matches[0] <= lastSourceIndex {
			return nil, errors.New("v2: native provider turns do not map uniquely and in order to source turns")
		}
		if thread.Source == domain.SourceClaude && strings.HasPrefix(fmt.Sprint(ref["nativeId"]), "turn:") {
			return nil, errors.New("v2: Claude provider turn has no source-backed assistant node identity")
		}
		lastSourceIndex = matches[0]
		copyTurn := cloneMap(nativeTurn)
		copyTurn["_sourceIndex"] = matches[0]
		result[id] = copyTurn
	}
	return result, nil
}

func sourceNativeTurnID(source domain.SourceName, turn domain.CanonicalTurn) (string, bool) {
	if source == domain.SourceCodex {
		return turn.ID, turn.ID != ""
	}
	if source != domain.SourceClaude || len(turn.Assistant) == 0 {
		return "", false
	}
	nativeID := claudeAssistantNodeID(turn.Assistant[len(turn.Assistant)-1].SourceID)
	return nativeID, nativeID != ""
}

func planSourceTurn(thread domain.CanonicalThread, index int, full Plan, attachmentsDir string) ([]Event, error) {
	turnThread := thread
	turnThread.Turns = []domain.CanonicalTurn{thread.Turns[index]}
	plan, err := BuildPlanWithRuntimeOptions(turnThread, full.ThreadID, full.ProjectID, full.ProviderInstanceID, thread.Model, map[string]any{}, false, attachmentsDir, false)
	if err != nil {
		return nil, err
	}
	fullEvents := make(map[string]Event, len(full.Events))
	for _, event := range full.Events {
		fullEvents[event.ID] = event
	}
	var events []Event
	for _, event := range plan.Events {
		if event.Type != "thread.created" && event.Type != "provider-thread.updated" {
			if complete, ok := fullEvents[event.ID]; ok {
				event = complete
			}
			events = append(events, event)
		}
	}
	return events, nil
}

func eventRows(events []Event) (messages, items, plans []map[string]any) {
	for _, event := range events {
		var payload map[string]any
		if json.Unmarshal(event.Payload, &payload) != nil {
			continue
		}
		switch event.Type {
		case "message.updated":
			messages = append(messages, payload)
		case "turn-item.updated":
			items = append(items, payload)
		case "plan.updated":
			plans = append(plans, payload)
		}
	}
	return
}

func projectionIDsEqual(actual []map[string]any, expected []string) bool {
	if len(actual) != len(expected) {
		return false
	}
	for index, row := range actual {
		if row["id"] != expected[index] {
			return false
		}
	}
	return true
}

func rowsForProjectionIDs(rows []map[string]any, ids []string) ([]map[string]any, []int, bool) {
	byID := make(map[string]int, len(rows))
	for index, row := range rows {
		id := valueString(row["id"])
		if id == "" {
			continue
		}
		if _, duplicate := byID[id]; duplicate {
			return nil, nil, false
		}
		byID[id] = index
	}
	selected := make([]map[string]any, 0, len(ids))
	indices := make([]int, 0, len(ids))
	for _, id := range ids {
		index, found := byID[id]
		if !found {
			return nil, nil, false
		}
		selected = append(selected, rows[index])
		indices = append(indices, index)
	}
	return selected, indices, true
}

func projectionHasID(rows []map[string]any, id string) bool {
	for _, row := range rows {
		if row["id"] == id {
			return true
		}
	}
	return false
}

func projectionIDs(rows []map[string]any) []string {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, valueString(row["id"]))
	}
	return ids
}

func sameItemIDs(left, right []map[string]any) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if valueString(left[index]["id"]) != valueString(right[index]["id"]) {
			return false
		}
	}
	return true
}

func nativeTurnItems(projection BuiltinProjection, providerTurn map[string]any, messages []map[string]any, run map[string]any, usageEvents map[string]Event) ([]map[string]any, []map[string]any) {
	messageIDs := make(map[string]bool, len(messages))
	for _, message := range messages {
		messageIDs[valueString(message["id"])] = true
	}
	providerTurnID := valueString(providerTurn["id"])
	runID := ""
	if run != nil {
		runID = valueString(run["id"])
	}
	var native, checkpoints []map[string]any
	for _, item := range projection.TurnItems {
		id := valueString(item["id"])
		if item["type"] == "checkpoint" {
			if runID != "" && item["runId"] == runID {
				checkpoints = append(checkpoints, item)
			}
			continue
		}
		_, isUsage := usageEvents[id]
		if item["providerTurnId"] == providerTurnID || messageIDs[valueString(item["messageId"])] || isUsage {
			native = append(native, item)
		}
	}
	return native, checkpoints
}

func eventPayload(event Event) map[string]any {
	var payload map[string]any
	if json.Unmarshal(event.Payload, &payload) != nil {
		return map[string]any{}
	}
	return payload
}

func sourceUsageEvents(events []Event, source domain.SourceName) []Event {
	prefix := "Historical " + string(source) + " token usage ("
	var result []Event
	for _, event := range events {
		if event.Type != "turn-item.updated" {
			continue
		}
		payload := eventPayload(event)
		if payload["type"] == "system_notice" && strings.HasPrefix(fmt.Sprint(payload["message"]), prefix) {
			result = append(result, event)
		}
	}
	return result
}

func excludeUsageEvents(events []Event, excluded map[string]bool) []Event {
	result := make([]Event, 0, len(events))
	for _, event := range events {
		if event.Type == "turn-item.updated" && excluded[valueString(eventPayload(event)["id"])] {
			continue
		}
		result = append(result, event)
	}
	return result
}

func projectionRowIndex(rows []map[string]any, id string) (int, bool) {
	for index, row := range rows {
		if row["id"] == id {
			return index, true
		}
	}
	return 0, false
}

func checkpointsForProviderTurn(projection BuiltinProjection, providerTurn map[string]any) ([]map[string]any, map[string]any) {
	attemptID := valueString(providerTurn["runAttemptId"])
	if attemptID == "" {
		return nil, nil
	}
	run := exactlyOneMap(projection.Runs, func(row map[string]any) bool {
		return row["activeAttemptId"] == attemptID && row["threadId"] == projection.Thread["id"]
	})
	if run == nil {
		return nil, nil
	}
	var items []map[string]any
	for _, item := range projection.TurnItems {
		if item["type"] == "checkpoint" && item["runId"] == run["id"] {
			items = append(items, item)
		}
	}
	return items, run
}

func projectionBindingsEqual(actual []map[string]any, expected []checkpoint.TurnItemBinding) bool {
	if len(expected) == 0 {
		return true
	}
	if len(actual) < len(expected) {
		return false
	}
	for index, saved := range expected {
		row := actual[index]
		if valueString(row["providerThreadId"]) != valueString(saved.ProviderThreadID) || valueString(row["providerTurnId"]) != valueString(saved.ProviderTurnID) || !reflect.DeepEqual(row["nativeItemRef"], saved.NativeItemRef) {
			return false
		}
	}
	return true
}

func semanticRowsMatch(messages, items, plans []map[string]any, events []Event, native bool) bool {
	expectedMessages, expectedItems, expectedPlans := eventRows(events)
	if len(messages) != len(expectedMessages) || len(items) != len(expectedItems) || len(plans) != len(expectedPlans) {
		return false
	}
	for index, expected := range expectedMessages {
		if native {
			if !semanticMapEqual(messages[index], expected, "id", "threadId", "runId", "nodeId", "creationSource", "createdAt", "updatedAt") {
				return false
			}
		} else if !semanticMapEqual(messages[index], expected, "id", "threadId") {
			return false
		}
	}
	for index, expected := range expectedItems {
		if native {
			if !semanticMapEqual(items[index], expected, "id", "threadId", "messageId", "ordinal", "runId", "nodeId", "providerThreadId", "providerTurnId", "nativeItemRef", "parentItemId", "creationSource", "startedAt", "completedAt", "updatedAt") {
				return false
			}
		} else if !semanticMapEqual(items[index], expected, "id", "threadId", "messageId", "ordinal") {
			return false
		}
	}
	for index, expected := range expectedPlans {
		ignored := []string{"id", "threadId", "nodeId"}
		if native {
			ignored = append(ignored, "runId")
		}
		if !semanticMapEqual(plans[index], expected, ignored...) {
			return false
		}
	}
	return true
}

func segmentHasImporterIDs(messages, items, plans, expectedMessages, expectedItems, expectedPlans []map[string]any) bool {
	if len(messages) != len(expectedMessages) || len(items) != len(expectedItems) || len(plans) != len(expectedPlans) {
		return false
	}
	for i, expected := range expectedMessages {
		if messages[i]["id"] != expected["id"] {
			return false
		}
	}
	for i, expected := range expectedItems {
		if items[i]["id"] != expected["id"] {
			return false
		}
	}
	for i, expected := range expectedPlans {
		if plans[i]["id"] != expected["id"] {
			return false
		}
	}
	return true
}

func eventsExactlyPresent(actual map[string]Event, expected []Event) bool {
	for _, event := range expected {
		got, ok := actual[event.ID]
		if !ok {
			return false
		}
		if got.Type == "turn-item.updated" && event.Type == "turn-item.updated" {
			gotPayload, wantPayload := eventPayload(got), eventPayload(event)
			delete(gotPayload, "ordinal")
			delete(wantPayload, "ordinal")
			got.Payload, _ = json.Marshal(gotPayload)
			event.Payload, _ = json.Marshal(wantPayload)
		}
		a, _ := StableEventJSON(got)
		b, _ := StableEventJSON(event)
		if !reflect.DeepEqual(a, b) {
			return false
		}
	}
	return true
}

func verifyNativeTurnSegment(messages, items, plans []map[string]any, expectedEvents []Event, sourceTurn domain.CanonicalTurn, providerTurn, provider map[string]any, source domain.SourceName) error {
	if !semanticRowsMatch(messages, items, plans, expectedEvents, true) {
		return errors.New("v2: native continuation content differs from its source turn")
	}
	providerTurnID := fmt.Sprint(providerTurn["id"])
	driver := "codex"
	if source == domain.SourceClaude {
		driver = "claudeAgent"
	}
	_, expectedItems, _ := eventRows(expectedEvents)
	expectedMessages, _, _ := eventRows(expectedEvents)
	for index, item := range items {
		expected := expectedItems[index]
		isUser := expected["type"] == "user_message"
		if isUser {
			if item["providerTurnId"] != nil && item["providerTurnId"] != providerTurnID {
				return errors.New("v2: native user item belongs to a different provider turn")
			}
		} else if item["providerTurnId"] != providerTurnID {
			return errors.New("v2: native item belongs to a different provider turn")
		}
		if item["providerThreadId"] != nil && item["providerThreadId"] != provider["id"] {
			return errors.New("v2: native item belongs to a different provider thread")
		}
		if expectedMessageID, ok := expected["messageId"].(string); ok {
			expectedIndex := -1
			for messageIndex, message := range expectedMessages {
				if message["id"] == expectedMessageID {
					expectedIndex = messageIndex
					break
				}
			}
			if expectedIndex < 0 || item["messageId"] != messages[expectedIndex]["id"] {
				return errors.New("v2: native item does not reference its corresponding message")
			}
			sourceNativeID := expectedNativeItemID(source, sourceTurn, expectedIndex)
			if sourceNativeID != "" && item["nativeItemRef"] != nil {
				ref, ok := item["nativeItemRef"].(map[string]any)
				if !ok || ref["driver"] != driver || ref["strength"] != "strong" || ref["nativeId"] != sourceNativeID {
					return errors.New("v2: native item references a different source item")
				}
			}
		}
	}
	return nil
}

func nativeExpectedTurnEvents(thread domain.CanonicalThread, turn domain.CanonicalTurn, events []Event) ([]Event, error) {
	if thread.Source != domain.SourceClaude {
		return events, nil
	}
	type assistantGroup struct {
		firstID string
		text    strings.Builder
		count   int
	}
	groups := map[string]*assistantGroup{}
	var order []string
	for _, message := range turn.Assistant {
		nodeID := claudeAssistantNodeID(message.SourceID)
		if nodeID == "" {
			return nil, errors.New("v2: Claude native continuation has an assistant message without a node identity")
		}
		group := groups[nodeID]
		if group == nil {
			group = &assistantGroup{firstID: uuid("t3-import:v2:message:" + thread.SourceKey + ":" + message.SourceID)}
			groups[nodeID] = group
			order = append(order, nodeID)
		}
		group.text.WriteString(message.Text)
		group.count++
	}
	if len(groups) == 0 {
		return events, nil
	}
	dropMessages := map[string]bool{}
	dropItems := map[string]bool{}
	joined := map[string]string{}
	for _, nodeID := range order {
		group := groups[nodeID]
		joined[group.firstID] = group.text.String()
		for _, message := range turn.Assistant {
			if claudeAssistantNodeID(message.SourceID) != nodeID {
				continue
			}
			id := uuid("t3-import:v2:message:" + thread.SourceKey + ":" + message.SourceID)
			if id != group.firstID {
				dropMessages[id] = true
				dropItems[id] = true
			}
		}
	}
	var normalized []Event
	for _, event := range events {
		var payload map[string]any
		if json.Unmarshal(event.Payload, &payload) != nil {
			return nil, errors.New("v2: malformed source event while normalizing Claude native history")
		}
		switch event.Type {
		case "message.updated":
			id, _ := payload["id"].(string)
			if dropMessages[id] {
				continue
			}
			if text, ok := joined[id]; ok {
				payload["text"] = text
			}
		case "turn-item.updated":
			messageID, _ := payload["messageId"].(string)
			if dropItems[messageID] {
				continue
			}
			if text, ok := joined[messageID]; ok {
				payload["text"] = text
			}
		}
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		event.Payload = encoded
		normalized = append(normalized, event)
	}
	return normalized, nil
}

func expectedNativeItemID(source domain.SourceName, turn domain.CanonicalTurn, expectedMessageIndex int) string {
	messages := append([]domain.CanonicalMessage{turn.User}, turn.Assistant...)
	if expectedMessageIndex < 0 || expectedMessageIndex >= len(messages) {
		return ""
	}
	message := messages[expectedMessageIndex]
	if source == domain.SourceClaude && message.Role == "assistant" {
		return claudeAssistantNodeID(message.SourceID)
	}
	return message.SourceID
}

func valueString(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(*string); ok {
		if text == nil {
			return ""
		}
		return *text
	}
	return fmt.Sprint(value)
}

func providerTurnForSource(turns map[string]map[string]any, sourceIndex int) map[string]any {
	for _, turn := range turns {
		if turn["_sourceIndex"] == sourceIndex {
			return turn
		}
	}
	return nil
}
