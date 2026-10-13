// Package app provides the shared Go workflows used by the CLI and Bubble Tea
// interface. Terminal front ends only collect choices and render these results.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/CarlosGtrz/t3-import/internal/domain"
	"github.com/CarlosGtrz/t3-import/internal/source/registry"
	"github.com/CarlosGtrz/t3-import/internal/target/config"
	"github.com/CarlosGtrz/t3-import/internal/target/launch"
	"github.com/CarlosGtrz/t3-import/internal/target/runtime"
)

const ProtocolVersion = 1

type Mode string

const (
	ModeAuto    Mode = "auto"
	ModeSync    Mode = "sync"
	ModeReplace Mode = "replace"
)

type Request struct {
	Action            string            `json:"action"`
	Source            domain.SourceName `json:"source,omitempty"`
	Workspace         string            `json:"workspace,omitempty"`
	Since             string            `json:"since,omitempty"`
	Mode              Mode              `json:"mode,omitempty"`
	SessionIDs        []string          `json:"sessionIds,omitempty"`
	Provider          string            `json:"provider,omitempty"`
	ResetCache        *bool             `json:"resetCache,omitempty"`
	Confirmed         bool              `json:"confirmed,omitempty"`
	All               bool              `json:"all,omitempty"`
	DryRun            bool              `json:"dryRun,omitempty"`
	NoResume          bool              `json:"noResume,omitempty"`
	ThreadID          string            `json:"threadId,omitempty"`
	IncludeIncomplete bool              `json:"includeIncomplete,omitempty"`
}

type targetPathsJSON struct {
	T3Home         string `json:"t3Home"`
	StateDir       string `json:"stateDir"`
	DBPath         string `json:"dbPath"`
	AttachmentsDir string `json:"attachmentsDir"`
}

type PreviewCounts struct {
	Tasks       int `json:"tasks"`
	Turns       int `json:"turns"`
	Messages    int `json:"messages"`
	Activities  int `json:"activities"`
	Attachments int `json:"attachments"`
}

type SyncPreview struct {
	Status       string `json:"status"`
	Selectable   bool   `json:"selectable"`
	NewTurns     int    `json:"newTurns"`
	AdoptedTurns int    `json:"adoptedTurns"`
	TitleChanged bool   `json:"titleChanged"`
}

type ReplacementPreview struct {
	Status             string   `json:"status"`
	Selectable         bool     `json:"selectable"`
	PreviouslyImported bool     `json:"previouslyImported"`
	OldThreadID        string   `json:"oldThreadId,omitempty"`
	OldThreadIDs       []string `json:"oldThreadIds,omitempty"`
	NewThreadID        string   `json:"newThreadId,omitempty"`
	Turns              int      `json:"turns"`
	Events             int      `json:"events"`
	Attachments        int      `json:"attachments"`
}

type PreviewSession struct {
	Summary       domain.SourceSummary         `json:"summary"`
	ImportPreview PreviewCounts                `json:"importPreview"`
	Sync          SyncPreview                  `json:"sync"`
	Replacement   ReplacementPreview           `json:"replacement"`
	Outcome       *domain.SessionOutcomeRecord `json:"outcome,omitempty"`
}

type Service struct {
	Paths   config.TargetPaths
	Sources *registry.Registry
}

func New(paths config.TargetPaths) *Service {
	return &Service{Paths: paths, Sources: registry.New()}
}

// Call performs one named workflow action and serializes its JSON response.
// It is useful to asynchronous Bubble Tea commands and remains independent of
// process launching or terminal I/O.
func (s *Service) Call(ctx context.Context, request Request) (json.RawMessage, error) {
	if s == nil || s.Sources == nil {
		return nil, errors.New("application service is not initialized")
	}
	if request.Mode == "" {
		request.Mode = ModeAuto
	}
	if request.Mode != ModeAuto && request.Mode != ModeSync && request.Mode != ModeReplace {
		return nil, fmt.Errorf("mode must be auto, sync, or replace")
	}
	var result any
	var err error
	switch request.Action {
	case "version":
		result = map[string]int{"protocolVersion": ProtocolVersion}
	case "preflight":
		result = map[string]any{"runtime": runtime.InspectRuntime(ctx, s.Paths), "target": targetPathsJSON{T3Home: s.Paths.T3Home, StateDir: s.Paths.StateDir, DBPath: s.Paths.DBPath, AttachmentsDir: s.Paths.AttachmentsDir}}
	case "launch":
		err = launch.LaunchT3Code()
		result = map[string]bool{"launched": err == nil}
	case "catalog":
		result, err = s.catalog(ctx, request)
	case "list":
		result, err = s.catalog(ctx, request)
	case "show":
		result, err = s.show(ctx, request)
	case "doctor":
		result, err = s.doctor(ctx)
	case "cache-reset":
		result, err = s.resetCache(ctx, request)
	case "providers":
		if !request.Source.Valid() {
			err = errors.New("source is required")
		} else {
			result = map[string]any{"providers": config.ListProviderInstances(s.Paths, request.Source)}
		}
	case "preview":
		result, err = s.preview(ctx, request)
	case "execute":
		if !request.Confirmed && !request.DryRun {
			err = errors.New("execute requires confirmed: true")
		} else {
			result, err = s.execute(ctx, request)
		}
	default:
		err = fmt.Errorf("unknown application action %q", request.Action)
	}
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(result)
	if err != nil {
		return nil, fmt.Errorf("encode application response: %w", err)
	}
	return data, nil
}

func (s *Service) catalog(ctx context.Context, request Request) (any, error) {
	if !request.Source.Valid() {
		return nil, errors.New("source is required")
	}
	adapter, err := s.Sources.Get(request.Source)
	if err != nil {
		return nil, withExitCode(2, err)
	}
	options, err := discoveryOptions(request)
	if err != nil {
		return nil, err
	}
	found, err := adapter.DiscoverWithOutcomes(ctx, options)
	if err != nil {
		return nil, withExitCode(5, err)
	}
	workspaces := make([]string, 0)
	seen := map[string]bool{}
	for _, summary := range found.Summaries {
		if !seen[summary.Workspace] {
			seen[summary.Workspace] = true
			workspaces = append(workspaces, summary.Workspace)
		}
	}
	sort.Strings(workspaces)
	return map[string]any{"summaries": found.Summaries, "outcomes": found.Outcomes, "workspaces": workspaces}, nil
}

func (s *Service) preview(ctx context.Context, request Request) (any, error) {
	if !request.Source.Valid() {
		return nil, errors.New("source is required")
	}
	if request.Workspace == "" {
		return nil, errors.New("workspace is required")
	}
	adapter, err := s.Sources.Get(request.Source)
	if err != nil {
		return nil, withExitCode(2, err)
	}
	discovery, err := discoveryOptions(request)
	if err != nil {
		return nil, err
	}
	workspace := request.Workspace
	discovery.Workspace = &workspace
	found, err := adapter.DiscoverWithOutcomes(ctx, discovery)
	if err != nil {
		return nil, withExitCode(5, err)
	}
	wanted := map[string]bool{}
	for _, id := range request.SessionIDs {
		wanted[id] = true
	}
	summaries := make([]domain.SourceSummary, 0, len(found.Summaries))
	for _, summary := range found.Summaries {
		if request.SessionIDs != nil && !wanted[summary.ID] {
			continue
		}
		summaries = append(summaries, summary)
	}
	previews := make([]PreviewSession, len(summaries))
	outcomes := append([]domain.SessionOutcomeRecord{}, found.Outcomes...)
	for i, summary := range summaries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		conversation, loadErr := adapter.Load(ctx, summary, discovery)
		if loadErr != nil {
			outcome := loadFailure(summary)
			previews[i] = PreviewSession{Summary: summary, Outcome: &outcome, Sync: SyncPreview{Status: "unavailable"}, Replacement: ReplacementPreview{Status: "unavailable"}}
			outcomes = append(outcomes, outcome)
			continue
		}
		previews[i], loadErr = s.inspectConversation(ctx, conversation, request.Mode, request)
		if loadErr != nil {
			outcome := loadFailure(summary)
			previews[i] = PreviewSession{Summary: summary, Outcome: &outcome, Sync: SyncPreview{Status: "unavailable"}, Replacement: ReplacementPreview{Status: "unavailable"}}
			outcomes = append(outcomes, outcome)
		}
	}
	return map[string]any{"sessions": previews, "outcomes": outcomes}, nil
}

func summarize(conversation domain.CanonicalConversation) PreviewCounts {
	return summarizeThreads(conversation.Threads)
}

func loadFailure(summary domain.SourceSummary) domain.SessionOutcomeRecord {
	return domain.SessionOutcomeRecord{
		Source: summary.Source, SessionID: stringValue(summary.ID), Workspace: stringValue(summary.Workspace), SourcePath: stringValue(summary.Path), DisplayName: summary.Title,
		Outcome: domain.SessionOutcome{Kind: domain.OutcomeFailed, Phase: domain.PhaseLoad, Code: "source-load-failed", Message: "The selected transcript could not be loaded, so it was not included in this operation.", NextAction: "Check that the transcript is still readable, then retry this session."},
	}
}

func stringValue(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
