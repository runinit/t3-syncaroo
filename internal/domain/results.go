package domain

type Sequence struct {
	First int `json:"first"`
	Last  int `json:"last"`
}

type CacheStatus string

const (
	CacheReset    CacheStatus = "reset"
	CacheNotFound CacheStatus = "not-found"
)

type ImportItemStatus string

const (
	ImportImported        ImportItemStatus = "imported"
	ImportAdopted         ImportItemStatus = "adopted"
	ImportAlreadyImported ImportItemStatus = "already-imported"
	ImportDryRun          ImportItemStatus = "dry-run"
	ImportConflict        ImportItemStatus = "conflict"
)

type ImportRunStatus string

const (
	ImportRunImported        ImportRunStatus = "imported"
	ImportRunDryRun          ImportRunStatus = "dry-run"
	ImportRunAlreadyImported ImportRunStatus = "already-imported"
	ImportRunMixed           ImportRunStatus = "mixed"
)

type SyncItemStatus string

const (
	SyncSynced            SyncItemStatus = "synced"
	SyncUpToDate          SyncItemStatus = "up-to-date"
	SyncHistoryDiverged   SyncItemStatus = "history-diverged"
	SyncBranchUnsupported SyncItemStatus = "branch-sync-unsupported"
	SyncTargetMissing     SyncItemStatus = "target-missing"
	SyncNotImported       SyncItemStatus = "not-imported"
	SyncDryRun            SyncItemStatus = "dry-run"
)

type SyncRunStatus string

const (
	SyncRunSynced   SyncRunStatus = "synced"
	SyncRunUpToDate SyncRunStatus = "up-to-date"
	SyncRunDryRun   SyncRunStatus = "dry-run"
	SyncRunMixed    SyncRunStatus = "mixed"
	SyncRunConflict SyncRunStatus = "conflict"
)

type SyncTitleAction string

const (
	TitleUpdated        SyncTitleAction = "updated"
	TitleUnchanged      SyncTitleAction = "unchanged"
	TitlePreservedLocal SyncTitleAction = "preserved-local"
)

type ReplaceItemStatus string

const (
	ReplaceReplaced          ReplaceItemStatus = "replaced"
	ReplaceAlreadyCurrent    ReplaceItemStatus = "already-current"
	ReplaceNotImported       ReplaceItemStatus = "not-imported"
	ReplaceActiveSource      ReplaceItemStatus = "active-source"
	ReplaceBranchUnsupported ReplaceItemStatus = "branch-replace-unsupported"
	ReplaceTargetMissing     ReplaceItemStatus = "target-missing"
	ReplaceHistoryConflict   ReplaceItemStatus = "history-conflict"
	ReplaceDryRun            ReplaceItemStatus = "dry-run"
)

type ReplaceRunStatus string

const (
	ReplaceRunReplaced       ReplaceRunStatus = "replaced"
	ReplaceRunAlreadyCurrent ReplaceRunStatus = "already-current"
	ReplaceRunDryRun         ReplaceRunStatus = "dry-run"
	ReplaceRunMixed          ReplaceRunStatus = "mixed"
	ReplaceRunConflict       ReplaceRunStatus = "conflict"
)

type CacheResetResult struct {
	Status   CacheStatus `json:"status"`
	Backup   *string     `json:"backup"`
	Profile  *string     `json:"profile"`
	Entries  []string    `json:"entries"`
	Warnings []string    `json:"warnings"`
}

type ImportItemResult struct {
	Source      SourceName       `json:"source"`
	SourceID    string           `json:"sourceId"`
	SourceKey   string           `json:"sourceKey"`
	Status      ImportItemStatus `json:"status"`
	ThreadID    string           `json:"threadId"`
	ProjectID   string           `json:"projectId"`
	Title       string           `json:"title"`
	Turns       int              `json:"turns"`
	Messages    int              `json:"messages"`
	Activities  int              `json:"activities"`
	Events      int              `json:"events"`
	Attachments int              `json:"attachments"`
	Resumable   bool             `json:"resumable"`
	Warnings    []string         `json:"warnings"`
	Sequence    *Sequence        `json:"sequence,omitempty"`
}

type ImportRunResult struct {
	SchemaVersion int                     `json:"schemaVersion"`
	Status        ImportRunStatus         `json:"status"`
	Target        string                  `json:"target"`
	Migration     int                     `json:"migration"`
	Backup        *string                 `json:"backup"`
	Cache         *CacheResetResult       `json:"cache,omitempty"`
	Results       []ImportItemResult      `json:"results"`
	Outcomes      *[]SessionOutcomeRecord `json:"outcomes,omitempty"`
	Diagnostics   *[]SessionOutcomeRecord `json:"diagnostics,omitempty"`
	Counts        *OperationOutcomeCounts `json:"counts,omitempty"`
	Warnings      []string                `json:"warnings"`
}

type SyncItemResult struct {
	Source       SourceName      `json:"source"`
	SourceID     string          `json:"sourceId"`
	SourceKey    string          `json:"sourceKey"`
	Status       SyncItemStatus  `json:"status"`
	ThreadID     *string         `json:"threadId,omitempty"`
	ProjectID    *string         `json:"projectId,omitempty"`
	Title        string          `json:"title"`
	TurnsAdded   int             `json:"turnsAdded"`
	TurnsAdopted int             `json:"turnsAdopted"`
	Events       int             `json:"events"`
	Attachments  int             `json:"attachments"`
	TitleAction  SyncTitleAction `json:"titleAction"`
	Resumable    bool            `json:"resumable"`
	Warnings     []string        `json:"warnings"`
	Sequence     *Sequence       `json:"sequence,omitempty"`
}

type SyncRunResult struct {
	SchemaVersion int                     `json:"schemaVersion"`
	Status        SyncRunStatus           `json:"status"`
	Target        string                  `json:"target"`
	Migration     int                     `json:"migration"`
	Backup        *string                 `json:"backup"`
	Cache         *CacheResetResult       `json:"cache,omitempty"`
	Results       []SyncItemResult        `json:"results"`
	Outcomes      *[]SessionOutcomeRecord `json:"outcomes,omitempty"`
	Diagnostics   *[]SessionOutcomeRecord `json:"diagnostics,omitempty"`
	Counts        *OperationOutcomeCounts `json:"counts,omitempty"`
	Warnings      []string                `json:"warnings"`
	HasConflicts  bool                    `json:"hasConflicts"`
}

type ReplaceItemResult struct {
	Source            SourceName        `json:"source"`
	SourceID          string            `json:"sourceId"`
	SourceKey         string            `json:"sourceKey"`
	Status            ReplaceItemStatus `json:"status"`
	OldThreadID       *string           `json:"oldThreadId,omitempty"`
	NewThreadID       *string           `json:"newThreadId,omitempty"`
	ProjectID         *string           `json:"projectId,omitempty"`
	Title             string            `json:"title"`
	Turns             int               `json:"turns"`
	Events            int               `json:"events"`
	Attachments       int               `json:"attachments"`
	ResumeTransferred bool              `json:"resumeTransferred"`
	OldThreadIDs      *[]string         `json:"oldThreadIds,omitempty"`
	Warnings          []string          `json:"warnings"`
	Sequence          *Sequence         `json:"sequence,omitempty"`
}

type ReplaceRunResult struct {
	SchemaVersion int                     `json:"schemaVersion"`
	Status        ReplaceRunStatus        `json:"status"`
	Target        string                  `json:"target"`
	Migration     int                     `json:"migration"`
	Backup        *string                 `json:"backup"`
	Cache         *CacheResetResult       `json:"cache,omitempty"`
	Results       []ReplaceItemResult     `json:"results"`
	Outcomes      *[]SessionOutcomeRecord `json:"outcomes,omitempty"`
	Diagnostics   *[]SessionOutcomeRecord `json:"diagnostics,omitempty"`
	Counts        *OperationOutcomeCounts `json:"counts,omitempty"`
	Warnings      []string                `json:"warnings"`
	HasConflicts  bool                    `json:"hasConflicts"`
}
