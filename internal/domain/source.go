// Package domain contains the importer’s provider-neutral data model.
package domain

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// SourceName identifies a supported transcript provider.
type SourceName string

const (
	SourceCodex  SourceName = "codex"
	SourceClaude SourceName = "claude"
)

func (s SourceName) Valid() bool { return s == SourceCodex || s == SourceClaude }

type ActivityTone string

const (
	ToneInfo     ActivityTone = "info"
	ToneTool     ActivityTone = "tool"
	ToneApproval ActivityTone = "approval"
	ToneError    ActivityTone = "error"
)

type TurnStatus string

const (
	TurnCompleted   TurnStatus = "completed"
	TurnInterrupted TurnStatus = "interrupted"
	TurnFailed      TurnStatus = "failed"
	TurnInProgress  TurnStatus = "inProgress"
)

func (s TurnStatus) Valid() bool {
	return s == TurnCompleted || s == TurnInterrupted || s == TurnFailed || s == TurnInProgress
}
func (s TurnStatus) Terminal() bool { return s.Valid() && s != TurnInProgress }

type SummaryStatus string

const (
	SummaryComplete   SummaryStatus = "complete"
	SummaryIncomplete SummaryStatus = "incomplete"
)

type SourceSummary struct {
	Source    SourceName    `json:"source"`
	ID        string        `json:"id"`
	Title     string        `json:"title"`
	Workspace string        `json:"workspace"`
	Path      string        `json:"path"`
	CreatedAt string        `json:"createdAt"`
	UpdatedAt string        `json:"updatedAt"`
	Status    SummaryStatus `json:"status"`
	Branches  int           `json:"branches"`
	ParentID  *string       `json:"parentId,omitempty"`
}

// Buffer mirrors Node.js Buffer's JSON representation so canonical JSON stays
// compatible with JSON.stringify in the TypeScript implementation.
type Buffer struct{ Data []byte }

func (b Buffer) MarshalJSON() ([]byte, error) {
	data := make([]int, len(b.Data))
	for i, value := range b.Data {
		data[i] = int(value)
	}
	return json.Marshal(struct {
		Type string `json:"type"`
		Data []int  `json:"data"`
	}{Type: "Buffer", Data: data})
}

func (b *Buffer) UnmarshalJSON(data []byte) error {
	var value struct {
		Type string `json:"type"`
		Data []int  `json:"data"`
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	if value.Type != "Buffer" {
		return fmt.Errorf("expected Node.js Buffer JSON, got %q", value.Type)
	}
	b.Data = make([]byte, len(value.Data))
	for i, number := range value.Data {
		if number < 0 || number > 255 {
			return fmt.Errorf("buffer byte %d out of range: %d", i, number)
		}
		b.Data[i] = byte(number)
	}
	return nil
}

type SourceAttachment struct {
	SourceID  string  `json:"sourceId"`
	Name      string  `json:"name"`
	MIMEType  string  `json:"mimeType"`
	SizeBytes int64   `json:"sizeBytes"`
	Path      *string `json:"path,omitempty"`
	Data      *Buffer `json:"data,omitempty"`
	RemoteURL *string `json:"remoteUrl,omitempty"`
}

type CanonicalMessage struct {
	SourceID    string             `json:"sourceId"`
	Role        string             `json:"role"`
	Text        string             `json:"text"`
	Timestamp   string             `json:"timestamp"`
	Attachments []SourceAttachment `json:"attachments"`
}

type CanonicalActivity struct {
	SourceID  string         `json:"sourceId"`
	Tone      ActivityTone   `json:"tone"`
	Kind      string         `json:"kind"`
	Summary   string         `json:"summary"`
	Payload   map[string]any `json:"payload"`
	Timestamp string         `json:"timestamp"`
}

type CanonicalPlan struct {
	SourceID  string `json:"sourceId"`
	Markdown  string `json:"markdown"`
	Timestamp string `json:"timestamp"`
}

type CanonicalTurn struct {
	ID             string              `json:"id"`
	StartedAt      string              `json:"startedAt"`
	CompletedAt    *string             `json:"completedAt,omitempty"`
	Status         TurnStatus          `json:"status"`
	TerminalReason *string             `json:"terminalReason,omitempty"`
	TerminalError  *string             `json:"terminalError,omitempty"`
	User           CanonicalMessage    `json:"user"`
	Assistant      []CanonicalMessage  `json:"assistant"`
	Activities     []CanonicalActivity `json:"activities"`
	Plans          []CanonicalPlan     `json:"plans"`
}

type CanonicalThread struct {
	Source                 SourceName      `json:"source"`
	SourceSessionID        string          `json:"sourceSessionId"`
	SourceKey              string          `json:"sourceKey"`
	LeafID                 *string         `json:"leafId,omitempty"`
	CurrentBranch          bool            `json:"currentBranch"`
	Title                  string          `json:"title"`
	Workspace              string          `json:"workspace"`
	GitBranch              *string         `json:"gitBranch,omitempty"`
	Model                  string          `json:"model"`
	Effort                 *string         `json:"effort,omitempty"`
	CreatedAt              string          `json:"createdAt"`
	UpdatedAt              string          `json:"updatedAt"`
	Turns                  []CanonicalTurn `json:"turns"`
	IgnoredInProgressTurns *int            `json:"ignoredInProgressTurns,omitempty"`
	ResumeCursor           map[string]any  `json:"resumeCursor,omitempty"`
	Warnings               []string        `json:"warnings"`
}

type CanonicalConversation struct {
	Summary     SourceSummary     `json:"summary"`
	Threads     []CanonicalThread `json:"threads"`
	Fingerprint string            `json:"fingerprint"`
}

type DiscoveryOptions struct {
	Workspace         *string    `json:"workspace,omitempty"`
	Since             *time.Time `json:"since,omitempty"`
	IncludeIncomplete *bool      `json:"includeIncomplete,omitempty"`
}

// SourceAdapter discovers provider sessions and normalizes them into the
// canonical model. Implementations own provider-specific parsing only.
type SourceAdapter interface {
	Name() SourceName
	Discover(context.Context, DiscoveryOptions) ([]SourceSummary, error)
	DiscoverWithOutcomes(context.Context, DiscoveryOptions) (SourceDiscoveryResult, error)
	Load(context.Context, SourceSummary, DiscoveryOptions) (CanonicalConversation, error)
}

type SourceDisposer interface{ Close() error }
