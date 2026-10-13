package domain

type OutcomeKind string

const (
	OutcomeSuccess         OutcomeKind = "success"
	OutcomeAlreadyImported OutcomeKind = "already-imported"
	OutcomeAdopted         OutcomeKind = "adopted"
	OutcomeDeferred        OutcomeKind = "deferred"
	OutcomeConflict        OutcomeKind = "conflict"
	OutcomeUnsupported     OutcomeKind = "unsupported"
	OutcomeFailed          OutcomeKind = "failed"
)

type OutcomePhase string

const (
	PhaseDiscovery OutcomePhase = "discovery"
	PhaseLoad      OutcomePhase = "load"
	PhasePreview   OutcomePhase = "preview"
	PhaseImport    OutcomePhase = "import"
	PhaseSync      OutcomePhase = "sync"
	PhaseReplace   OutcomePhase = "replace"
	PhaseCache     OutcomePhase = "cache"
)

type SessionOutcome struct {
	Kind       OutcomeKind  `json:"kind"`
	Phase      OutcomePhase `json:"phase"`
	Code       string       `json:"code"`
	Message    string       `json:"message"`
	NextAction string       `json:"nextAction"`
}

type SessionOutcomeRecord struct {
	Source      SourceName     `json:"source"`
	SessionID   *string        `json:"sessionId,omitempty"`
	Workspace   *string        `json:"workspace,omitempty"`
	SourcePath  *string        `json:"sourcePath,omitempty"`
	DisplayName string         `json:"displayName"`
	Outcome     SessionOutcome `json:"outcome"`
}

type OperationOutcomeCounts struct {
	Success         int `json:"success"`
	Imported        int `json:"imported"`
	Adopted         int `json:"adopted"`
	Synced          int `json:"synced"`
	Replaced        int `json:"replaced"`
	Planned         int `json:"planned"`
	AlreadyImported int `json:"alreadyImported"`
	Deferred        int `json:"deferred"`
	Conflict        int `json:"conflict"`
	Unsupported     int `json:"unsupported"`
	Failed          int `json:"failed"`
	ScanDiagnostics int `json:"scanDiagnostics"`
	Classified      int `json:"classified"`
}

type SourceDiscoveryResult struct {
	Summaries []SourceSummary        `json:"summaries"`
	Outcomes  []SessionOutcomeRecord `json:"outcomes"`
}
