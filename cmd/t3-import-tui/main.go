package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/runinit/t3-syncaroo/internal/app"
	"github.com/runinit/t3-syncaroo/internal/domain"
	"github.com/runinit/t3-syncaroo/internal/target/config"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type runtimeInfo struct {
	Live   bool   `json:"live"`
	PID    int    `json:"pid"`
	Origin string `json:"origin"`
}
type summary struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Workspace string `json:"workspace"`
}
type preview struct {
	Summary       summary       `json:"summary"`
	ImportPreview importPreview `json:"importPreview"`
	Sync          struct {
		Status       string `json:"status"`
		Selectable   bool   `json:"selectable"`
		NewTurns     int    `json:"newTurns"`
		AdoptedTurns int    `json:"adoptedTurns"`
		TitleChanged bool   `json:"titleChanged"`
	} `json:"sync"`
	Replacement struct {
		Status             string   `json:"status"`
		Selectable         bool     `json:"selectable"`
		PreviouslyImported bool     `json:"previouslyImported"`
		OldThreadID        string   `json:"oldThreadId"`
		OldThreadIDs       []string `json:"oldThreadIds"`
		NewThreadID        string   `json:"newThreadId"`
		Turns              int      `json:"turns"`
		Events             int      `json:"events"`
		Attachments        int      `json:"attachments"`
	} `json:"replacement"`
}
type importPreview struct {
	Tasks       int `json:"tasks"`
	Turns       int `json:"turns"`
	Messages    int `json:"messages"`
	Activities  int `json:"activities"`
	Attachments int `json:"attachments"`
}
type resultData struct {
	Imported *operationSummary `json:"imported"`
	Synced   *operationSummary `json:"synced"`
	Replaced *operationSummary `json:"replaced"`
	Outcomes []outcome         `json:"outcomes"`
}
type operationSummary struct {
	Results []struct {
		Title    string   `json:"title"`
		SourceID string   `json:"sourceId"`
		Status   string   `json:"status"`
		Warnings []string `json:"warnings"`
	} `json:"results"`
	Warnings []string      `json:"warnings"`
	Backup   string        `json:"backup"`
	Cache    *cacheSummary `json:"cache"`
}
type cacheSummary struct {
	Backup string `json:"backup"`
}
type outcome struct {
	DisplayName string `json:"displayName"`
	SessionID   string `json:"sessionId"`
	Outcome     struct {
		Kind       string `json:"kind"`
		Message    string `json:"message"`
		NextAction string `json:"nextAction"`
	} `json:"outcome"`
}
type serviceData struct {
	Runtime    runtimeInfo     `json:"runtime"`
	Workspaces []string        `json:"workspaces"`
	Providers  []string        `json:"providers"`
	Summaries  []summary       `json:"summaries"`
	Sessions   []preview       `json:"sessions"`
	Outcomes   []outcome       `json:"outcomes"`
	Operation  resultData      `json:"-"`
	Raw        json.RawMessage `json:"-"`
}
type serviceMsg struct {
	data serviceData
	err  error
}
type serviceCaller interface {
	Call(context.Context, app.Request) (json.RawMessage, error)
}
type spinnerTickMsg time.Time

var (
	titleStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7dd3fc"))
	mutedStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("#94a3b8"))
	selectedStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#f8fafc")).Background(lipgloss.Color("#155e75"))
	accentStyle   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#67e8f9"))
	okStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("#86efac"))
	warnStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("#fcd34d"))
	errorStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("#fca5a5"))
)

type model struct {
	stage, source, workspace, provider, mode string
	t3Home, dbPath, attachmentsDir           string
	workspaces, providers                    []string
	items                                    []preview
	outcomes                                 []outcome
	selected                                 map[string]bool
	cursor                                   int
	hover                                    int
	width, height                            int
	scroll                                   int
	frame                                    int
	searching                                bool
	query                                    string
	message                                  string
	busy, writing                            bool
	cancel                                   context.CancelFunc
	resetCache                               bool
	rawResult                                json.RawMessage
	launchChoice                             int
	service                                  serviceCaller
}

func spinnerTick() tea.Cmd {
	return tea.Tick(90*time.Millisecond, func(now time.Time) tea.Msg { return spinnerTickMsg(now) })
}
func invoke(service serviceCaller, request app.Request) (tea.Cmd, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	cmd := func() tea.Msg {
		out, err := service.Call(ctx, request)
		if err != nil {
			if ctx.Err() == context.Canceled {
				return serviceMsg{err: ctx.Err()}
			}
			return serviceMsg{err: err}
		}
		var data serviceData
		if len(out) > 0 {
			if err := json.Unmarshal(out, &data); err != nil {
				return serviceMsg{err: fmt.Errorf("invalid service response: %w", err)}
			}
		}
		data.Raw = out
		return serviceMsg{data: data}
	}
	return cmd, cancel
}
func (m *model) request(request app.Request, stage string, write bool) tea.Cmd {
	if stage != "" {
		m.setStage(stage)
	}
	m.busy, m.writing = true, write
	if write {
		m.message = "Rechecking T3 and writing the selected history…"
	} else {
		m.message = "Loading…"
	}
	cmd, cancel := invoke(m.service, request)
	m.cancel = cancel
	return tea.Batch(cmd, spinnerTick())
}
func (m *model) setStage(stage string) {
	if m.stage == stage {
		return
	}
	m.stage, m.scroll, m.hover = stage, 0, -1
}
func initial(opts options) model {
	paths := config.ResolveTargetPaths(config.TargetOverrides{T3Home: opts.t3Home, DBPath: opts.dbPath, AttachmentsDir: opts.attachmentsDir})
	return model{stage: "preflight", source: opts.source, workspace: opts.workspace, provider: opts.provider, mode: opts.mode, t3Home: opts.t3Home, dbPath: opts.dbPath, attachmentsDir: opts.attachmentsDir, selected: map[string]bool{}, resetCache: opts.resetCache, launchChoice: 0, width: 100, height: 28, hover: -1, service: app.New(paths)}
}
func (m model) Init() tea.Cmd { return m.request(app.Request{Action: "preflight"}, "preflight", false) }
func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case serviceMsg:
		m.busy, m.writing, m.cancel = false, false, nil
		if v.err != nil {
			if v.err == context.Canceled {
				m.message = "Read cancelled."
				m.setStage("source")
				return m, nil
			}
			m.message = v.err.Error()
			m.setStage("error")
			return m, nil
		}
		switch m.stage {
		case "preflight":
			if v.data.Runtime.Live {
				m.message = "T3 is running. Close T3 before importing, syncing, or replacing."
				if v.data.Runtime.PID > 0 {
					m.message += fmt.Sprintf(" Detected PID %d.", v.data.Runtime.PID)
				}
				m.setStage("blocked")
				return m, nil
			}
			if m.source == "" {
				m.setStage("source")
				m.message = "Choose source"
				return m, nil
			}
			return m, m.request(app.Request{Action: "catalog", Source: domain.SourceName(m.source)}, "catalog", false)
		case "catalog":
			m.workspaces = v.data.Workspaces
			m.outcomes = v.data.Outcomes
			sort.Strings(m.workspaces)
			m.setStage("workspace")
			m.message = "Choose a workspace"
			if m.workspace != "" {
				for _, w := range m.workspaces {
					if strings.EqualFold(w, m.workspace) {
						m.workspace = w
						return m, m.loadProviders()
					}
				}
			}
		case "providers":
			m.providers = v.data.Providers
			if len(m.providers) == 0 {
				m.message = "No provider instances are available."
				m.setStage("error")
				return m, nil
			}
			if m.provider != "" {
				found := false
				for _, id := range m.providers {
					if id == m.provider {
						found = true
						break
					}
				}
				if !found {
					m.message = fmt.Sprintf("Provider instance %q is not available for %s.", m.provider, m.source)
					m.setStage("error")
					return m, nil
				}
				return m, m.loadSessions()
			}
			if len(m.providers) == 1 {
				m.provider = m.providers[0]
				return m, m.loadSessions()
			}
			m.setStage("provider")
			m.message = "Choose a T3 provider instance"
		case "preview":
			m.items = v.data.Sessions
			m.outcomes = v.data.Outcomes
			m.selected = map[string]bool{}
			m.cursor = 0
			m.setStage("sessions")
			m.message = "Select conversations · Space select · Enter review · / search"
		case "execute":
			m.rawResult = v.data.Raw
			m.setStage("result")
			m.message = "Operation complete. Start T3 Code?"
		case "launch":
			m.setStage("done")
			m.message = "T3 Code started. Press q to quit."
		}
		m.cursor = 0
	case spinnerTickMsg:
		if m.busy {
			m.frame = (m.frame + 1) % 10
			return m, spinnerTick()
		}
	case tea.WindowSizeMsg:
		m.width, m.height = v.Width, v.Height
		if m.stage == "review" || m.stage == "result" {
			m.scrollBody(0)
		} else {
			m.keepCursorVisible()
		}
	case tea.MouseMsg:
		if m.busy {
			return m, nil
		}
		if v.Action == tea.MouseActionMotion {
			m.hover = v.Y - m.listTop() + m.scroll
			return m, nil
		}
		if v.Action != tea.MouseActionPress {
			return m, nil
		}
		if v.Button == tea.MouseButtonWheelUp || v.Button == tea.MouseButtonWheelDown {
			delta := -3
			if v.Button == tea.MouseButtonWheelDown {
				delta = 3
			}
			if m.stage == "result" || m.stage == "review" {
				m.scrollBody(delta)
			} else {
				m.cursor = max(0, min(max(0, m.listLength()-1), m.cursor+delta))
				m.keepCursorVisible()
			}
			return m, nil
		}
		if v.Button != tea.MouseButtonLeft {
			return m, nil
		}
		if v.Y == m.height-1 {
			if m.stage == "review" {
				if v.X < m.width/2 {
					return m, m.confirmWrite()
				}
				m.setStage("sessions")
				m.message = "Selection cancelled."
				return m, nil
			}
			if m.stage == "result" {
				if v.X < m.width/2 {
					return m, m.request(app.Request{Action: "launch"}, "launch", false)
				}
				return m, tea.Quit
			}
		}
		index := v.Y - m.listTop() + m.scroll
		if index < 0 {
			return m, nil
		}
		m.cursor = index
		switch m.stage {
		case "sessions":
			if p := m.current(); p != nil && m.eligible(*p) {
				if m.selected[p.Summary.ID] {
					delete(m.selected, p.Summary.ID)
				} else {
					m.selected[p.Summary.ID] = true
				}
			}
		case "source", "workspace", "provider":
			return m.Update(tea.KeyMsg{Type: tea.KeyEnter})
		}
	case tea.KeyMsg:
		key := v
		if m.searching {
			if key.String() == "esc" || key.String() == "enter" {
				m.searching = false
				m.cursor = 0
			} else if key.String() == "backspace" {
				if len(m.query) > 0 {
					m.query = m.query[:len(m.query)-1]
				}
			} else if len(key.Runes) > 0 {
				m.query += string(key.Runes)
			}
			return m, nil
		}
		if m.busy {
			if !m.writing && key.String() == "esc" && m.cancel != nil {
				m.cancel()
				return m, nil
			}
			return m, nil
		}
		switch key.String() {
		case "ctrl+c", "q":
			if m.stage == "result" {
				return m, tea.Quit
			}
			return m, tea.Quit
		case "up", "k", "pgup":
			if key.String() == "pgup" {
				if m.stage == "result" || m.stage == "review" {
					m.scrollBody(-8)
				} else {
					m.cursor = max(0, m.cursor-8)
					m.keepCursorVisible()
				}
				break
			}
			if m.stage == "review" {
				m.scrollBody(-1)
				break
			}
			if m.cursor > 0 {
				m.cursor--
			}
			m.keepCursorVisible()
			if m.stage == "result" {
				m.launchChoice = m.cursor
			}
		case "down", "j", "pgdown":
			if key.String() == "pgdown" {
				if m.stage == "result" || m.stage == "review" {
					m.scrollBody(8)
				} else {
					m.cursor = min(max(0, m.listLength()-1), m.cursor+8)
					m.keepCursorVisible()
				}
				break
			}
			if m.stage == "review" {
				m.scrollBody(1)
				break
			}
			if m.cursor+1 < m.listLength() {
				m.cursor++
			}
			m.keepCursorVisible()
			if m.stage == "result" {
				m.launchChoice = m.cursor
			}
		case "esc":
			switch m.stage {
			case "workspace":
				m.setStage("source")
			case "provider":
				m.setStage("workspace")
			case "sessions":
				m.setStage("workspace")
			case "review":
				m.setStage("sessions")
			default:
				return m, tea.Quit
			}
			m.cursor = 0
		case "/":
			if m.stage == "sessions" {
				m.searching = true
			}
		case " ":
			if m.stage == "sessions" {
				if p := m.current(); p != nil && m.eligible(*p) {
					if m.selected[p.Summary.ID] {
						delete(m.selected, p.Summary.ID)
					} else {
						m.selected[p.Summary.ID] = true
					}
				}
			}
		case "a":
			if m.stage == "sessions" {
				m.toggleAll()
			}
		case "enter":
			switch m.stage {
			case "source":
				if m.cursor == 0 {
					m.source = "codex"
				} else {
					m.source = "claude"
				}
				m.cursor = 0
				return m, m.request(app.Request{Action: "catalog", Source: domain.SourceName(m.source)}, "catalog", false)
			case "workspace":
				if m.cursor < len(m.workspaces) {
					m.workspace = m.workspaces[m.cursor]
					return m, m.loadProviders()
				}
			case "provider":
				if m.cursor < len(m.providers) {
					m.provider = m.providers[m.cursor]
					return m, m.loadSessions()
				}
			case "sessions":
				if len(m.selected) == 0 {
					m.message = "Select at least one eligible conversation."
				} else {
					m.setStage("review")
					m.message = fmt.Sprintf("Review %d selected conversation(s). Press Enter to confirm, Esc to cancel.", len(m.selected))
				}
			case "review":
				return m, m.confirmWrite()
			case "result":
				if m.launchChoice == 0 {
					return m, m.request(app.Request{Action: "launch"}, "launch", false)
				}
				return m, tea.Quit
			case "blocked":
				return m, m.request(app.Request{Action: "preflight"}, "preflight", false)
			case "error", "done":
				return m, tea.Quit
			}
		}
	}
	return m, nil
}
func (m model) visible() []preview {
	if m.query == "" {
		return m.items
	}
	q := strings.ToLower(m.query)
	out := make([]preview, 0, len(m.items))
	for _, p := range m.items {
		if strings.Contains(strings.ToLower(p.Summary.Title), q) || strings.Contains(strings.ToLower(p.Summary.ID), q) {
			out = append(out, p)
		}
	}
	return out
}
func (m model) listLength() int {
	switch m.stage {
	case "source", "result":
		return 2
	case "workspace":
		return len(m.workspaces)
	case "provider":
		return len(m.providers)
	case "sessions":
		return len(m.visible())
	default:
		return 0
	}
}
func (m model) current() *preview {
	v := m.visible()
	if m.cursor < 0 || m.cursor >= len(v) {
		return nil
	}
	return &v[m.cursor]
}
func (m model) eligible(p preview) bool {
	category := func(item preview) string {
		switch m.mode {
		case "sync":
			if item.Sync.Status == "syncable" {
				return "regular"
			}
		case "replace":
			if item.Replacement.Selectable {
				return "replace"
			}
		default:
			if item.Sync.Status == "history-diverged" && item.Replacement.Selectable {
				return "replace"
			}
			if item.Sync.Selectable {
				return "regular"
			}
		}
		return ""
	}
	current := category(p)
	if current == "" {
		return false
	}
	for id := range m.selected {
		for _, selected := range m.items {
			if selected.Summary.ID == id && category(selected) != current {
				return false
			}
		}
	}
	return true
}
func (m *model) toggleAll() {
	v := m.visible()
	all := true
	for _, p := range v {
		if m.eligible(p) && !m.selected[p.Summary.ID] {
			all = false
		}
	}
	for _, p := range v {
		if m.eligible(p) {
			if all {
				delete(m.selected, p.Summary.ID)
			} else {
				m.selected[p.Summary.ID] = true
			}
		}
	}
}
func (m model) selectedIDs() []string {
	var ids []string
	for id := range m.selected {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
func (m model) selectedPreviews() []preview {
	selected := make([]preview, 0, len(m.selected))
	for _, id := range m.selectedIDs() {
		for _, item := range m.items {
			if item.Summary.ID == id {
				selected = append(selected, item)
				break
			}
		}
	}
	return selected
}
func (m model) loadProviders() tea.Cmd {
	return m.request(app.Request{Action: "providers", Source: domain.SourceName(m.source)}, "providers", false)
}
func (m model) loadSessions() tea.Cmd {
	return m.request(app.Request{Action: "preview", Source: domain.SourceName(m.source), Workspace: m.workspace, Mode: app.Mode(m.mode)}, "preview", false)
}
func (m model) listTop() int {
	if m.stage == "sessions" && (m.searching || m.query != "") {
		return 5
	}
	return 4
}
func (m *model) keepCursorVisible() {
	if m.stage == "review" || m.stage == "result" {
		return
	}
	rows := m.height - 6
	if rows < 1 {
		rows = 1
	}
	if m.cursor < m.scroll {
		m.scroll = m.cursor
	}
	if m.cursor >= m.scroll+rows {
		m.scroll = m.cursor - rows + 1
	}
	if m.scroll < 0 {
		m.scroll = 0
	}
}
func (m *model) scrollBody(delta int) {
	height := m.height
	if height < 12 {
		height = 12
	}
	visibleRows := height - 6
	maxScroll := max(0, len(m.bodyRows())-visibleRows)
	m.scroll = max(0, min(maxScroll, m.scroll+delta))
}
func (m *model) confirmWrite() tea.Cmd {
	ids := m.selectedIDs()
	resetCache := m.resetCache
	return m.request(app.Request{Action: "execute", Source: domain.SourceName(m.source), Workspace: m.workspace, Mode: app.Mode(m.mode), SessionIDs: ids, Provider: m.provider, ResetCache: &resetCache, Confirmed: true}, "execute", true)
}
func (m model) bodyRows() []string {
	var rows []string
	addMenu := func(items []string) {
		for i, item := range items {
			prefix := "  "
			if i == m.cursor {
				prefix = "› "
			}
			text := prefix + item
			if i == m.cursor || i == m.hover {
				rows = append(rows, selectedStyle.Render(text))
			} else {
				rows = append(rows, text)
			}
		}
	}
	switch m.stage {
	case "source":
		addMenu([]string{"Codex", "Claude Code"})
	case "workspace":
		addMenu(m.workspaces)
	case "provider":
		addMenu(m.providers)
	case "sessions":
		if m.searching || m.query != "" {
			rows = append(rows, accentStyle.Render("Search: ")+m.query+"_")
		}
		for i, p := range m.visible() {
			mark, status := "○", p.Sync.Status
			if m.selected[p.Summary.ID] {
				mark = "●"
			}
			if p.Sync.Status == "history-diverged" && p.Replacement.Selectable {
				status += " · replace available"
			}
			if m.mode == "replace" {
				status = p.Replacement.Status
			}
			line := fmt.Sprintf("%s %s  %s  ·  %s", mark, p.Summary.Title, p.Summary.ID, status)
			if !m.eligible(p) {
				line += "  unavailable"
			}
			if i == m.cursor || i == m.hover {
				line = selectedStyle.Render("› " + line)
			}
			if !m.eligible(p) {
				line = mutedStyle.Render(line)
			}
			rows = append(rows, line)
		}
		for _, issue := range m.outcomes {
			name := issue.SessionID
			if name == "" {
				name = issue.DisplayName
			}
			rows = append(rows, warnStyle.Render("! "+issue.Outcome.Kind)+fmt.Sprintf(" · %s: %s  Next: %s", name, issue.Outcome.Message, issue.Outcome.NextAction))
		}
	case "review":
		rows = append(rows,
			fmt.Sprintf("Source      %s", m.source),
			fmt.Sprintf("Workspace   %s", m.workspace),
			fmt.Sprintf("Provider    %s", m.provider),
			fmt.Sprintf("Mode        %s · %d conversation(s)", m.mode, len(m.selected)),
			"Scroll with the wheel or Page Up/Down to inspect the full batch.",
		)
		for _, item := range m.selectedPreviews() {
			title := item.Summary.Title
			if title == "" {
				title = item.Summary.ID
			}
			rows = append(rows, "", accentStyle.Render(title+" · "+item.Summary.ID))
			if m.mode == "replace" || (m.mode == "auto" && item.Sync.Status == "history-diverged" && item.Replacement.Selectable) {
				rows = append(rows, fmt.Sprintf("  Replace with %s · %s · %s", countLabel(item.Replacement.Turns, "turn"), countLabel(item.Replacement.Events, "event"), countLabel(item.Replacement.Attachments, "attachment")))
				oldIDs := item.Replacement.OldThreadIDs
				if len(oldIDs) == 0 && item.Replacement.OldThreadID != "" {
					oldIDs = []string{item.Replacement.OldThreadID}
				}
				if len(oldIDs) > 0 {
					rows = append(rows, "  Existing T3 task(s): "+strings.Join(oldIDs, ", "))
				}
				if item.Replacement.NewThreadID != "" {
					rows = append(rows, "  New T3 task: "+item.Replacement.NewThreadID)
				}
			} else if m.mode == "auto" && item.Sync.Status == "new" {
				counts := item.ImportPreview
				rows = append(rows, fmt.Sprintf("  Import %s · %s · %s · %s · %s", countLabel(counts.Tasks, "task"), countLabel(counts.Turns, "turn"), countLabel(counts.Messages, "message"), countLabel(counts.Activities, "activity"), countLabel(counts.Attachments, "attachment")))
			} else {
				rows = append(rows, fmt.Sprintf("  Synchronize · %s · %s", countLabel(item.Sync.NewTurns, "new turn"), countLabel(item.Sync.AdoptedTurns, "adopted turn")))
				if item.Sync.TitleChanged {
					rows = append(rows, "  Update the T3 task title")
				}
			}
		}
		rows = append(rows, "", warnStyle.Render("T3 must be closed. The backend rechecks before writing and creates verified backups."))
		if m.resetCache {
			rows = append(rows, "A verified T3 UI cache backup will be created after changes.")
		} else {
			rows = append(rows, "The existing T3 UI cache will be kept.")
		}
		rows = append(rows, "The write cannot be interrupted once confirmed.")
	case "result":
		rows = m.resultRows()
	case "blocked":
		rows = append(rows, errorStyle.Render("T3 is running."), "Close T3, then choose Recheck.")
	case "error":
		rows = append(rows, "Press Enter or q to exit.")
	case "done":
		rows = append(rows, okStyle.Render("T3 Code started."), "Press q to quit.")
	}
	return rows
}
func countLabel(count int, noun string) string {
	if count == 1 {
		return fmt.Sprintf("1 %s", noun)
	}
	plural := noun + "s"
	if strings.HasSuffix(noun, "y") {
		plural = noun[:len(noun)-1] + "ies"
	}
	return fmt.Sprintf("%d %s", count, plural)
}
func (m model) resultRows() []string {
	rows := []string{}
	var result resultData
	if err := json.Unmarshal(m.rawResult, &result); err != nil {
		return []string{errorStyle.Render("The backend returned an unreadable result."), err.Error()}
	}
	for _, item := range []struct {
		name  string
		value *operationSummary
	}{{"Imported", result.Imported}, {"Synchronized", result.Synced}, {"Replaced", result.Replaced}} {
		if item.value == nil {
			continue
		}
		rows = append(rows, titleStyle.Render(item.name))
		backup := item.value.Backup
		if backup == "" {
			backup = "not needed"
		}
		rows = append(rows, mutedStyle.Render("  Database backup: "+backup))
		if item.value.Cache != nil {
			cacheBackup := item.value.Cache.Backup
			if cacheBackup == "" {
				cacheBackup = "cache not found"
			}
			rows = append(rows, mutedStyle.Render("  Cache backup: "+cacheBackup))
		}
		for _, operation := range item.value.Results {
			label := operation.Title
			if label == "" {
				label = operation.SourceID
			}
			line := fmt.Sprintf("  %s · %s", operation.Status, label)
			if operation.Status == "conflict" || operation.Status == "failed" {
				line = errorStyle.Render(line)
			} else if operation.Status == "deferred" || operation.Status == "unsupported" {
				line = warnStyle.Render(line)
			} else {
				line = okStyle.Render(line)
			}
			rows = append(rows, line)
			for _, warning := range operation.Warnings {
				rows = append(rows, warnStyle.Render("    Warning: "+warning))
			}
			if guidance := nextActionForStatus(operation.Status); guidance != "" {
				rows = append(rows, mutedStyle.Render("    Next: "+guidance))
			}
		}
		for _, warning := range item.value.Warnings {
			rows = append(rows, warnStyle.Render("  Warning: ")+warning)
		}
	}
	for _, issue := range result.Outcomes {
		label := issue.SessionID
		if label == "" {
			label = issue.DisplayName
		}
		rows = append(rows, warnStyle.Render("! "+issue.Outcome.Kind)+fmt.Sprintf(" · %s: %s", label, issue.Outcome.Message))
		if issue.Outcome.NextAction != "" {
			rows = append(rows, mutedStyle.Render("  Next: "+issue.Outcome.NextAction))
		}
	}
	if len(rows) == 0 {
		rows = append(rows, okStyle.Render("No changes were needed."))
	}
	return rows
}
func nextActionForStatus(status string) string {
	switch status {
	case "conflict":
		return "Keep the existing T3 task and resolve the source-history mismatch before retrying."
	case "history-diverged":
		return "Use replace to apply the changed provider history to this T3 task."
	case "active-source":
		return "Wait for the provider session to finish, then retry."
	case "target-missing", "not-imported":
		return "Import this conversation before synchronizing or replacing it."
	case "branch-sync-unsupported", "branch-replace-unsupported":
		return "This operation supports only single-branch conversations."
	default:
		return ""
	}
}
func (m model) View() string {
	width, height := m.width, m.height
	if width < 40 {
		width = 40
	}
	if height < 12 {
		height = 12
	}
	mode := m.mode
	if mode == "" {
		mode = "auto"
	}
	header := titleStyle.Render("T3  /  IMPORT") + "  " + mutedStyle.Render("Codex + Claude Code") + "  " + accentStyle.Render("["+mode+"]")
	message := m.message
	if m.busy {
		frames := []string{"◐", "◓", "◑", "◒"}
		message = frames[m.frame%len(frames)] + "  " + message
	}
	if m.stage == "error" {
		message = errorStyle.Render(message)
	} else if m.stage == "done" {
		message = okStyle.Render(message)
	} else {
		message = accentStyle.Render(message)
	}
	rows := []string{header, mutedStyle.Render("A safe local migration tool"), message, ""}
	if m.busy && !m.writing {
		rows[2] += mutedStyle.Render("   Esc cancels this read")
	}
	body := m.bodyRows()
	maxBody := height - 6
	if maxBody < 1 {
		maxBody = 1
	}
	start := min(m.scroll, max(0, len(body)-maxBody))
	end := min(len(body), start+maxBody)
	for i := start; i < end; i++ {
		rows = append(rows, lipgloss.NewStyle().MaxWidth(width-4).Render(body[i]))
	}
	if len(body) == 0 {
		rows = append(rows, mutedStyle.Render("No entries found."))
	}
	for len(rows) < height-1 {
		rows = append(rows, "")
	}
	footer := mutedStyle.Render("↑/↓ move · Space select · / search · Enter continue · q quit")
	if m.stage == "sessions" {
		footer = mutedStyle.Render("Click or Space select · wheel scroll · / search · a all · Enter review")
	}
	if m.stage == "review" {
		left, right := "[ Confirm write ]", "[ Cancel ]"
		footer = accentStyle.Render(left) + strings.Repeat(" ", max(1, width-len(left)-len(right))) + mutedStyle.Render(right)
	}
	if m.stage == "result" {
		left, right := "[ Start T3 Code ]", "[ Exit ]"
		leftStyle, rightStyle := mutedStyle, mutedStyle
		if m.launchChoice == 0 {
			left, leftStyle = "> "+left, accentStyle
		} else {
			right, rightStyle = "> "+right, accentStyle
		}
		spaces := max(1, width-lipgloss.Width(left)-lipgloss.Width(right))
		footer = leftStyle.Render(left) + strings.Repeat(" ", spaces) + rightStyle.Render(right)
	}
	rows = append(rows, lipgloss.NewStyle().Width(width).Render(footer))
	return strings.Join(rows, "\n")
}

type options struct {
	source, workspace, provider, mode string
	t3Home, dbPath, attachmentsDir    string
	resetCache                        bool
}

func parseOptions() options {
	o := options{mode: "auto", resetCache: true}
	flag.StringVar(&o.source, "source", "", "codex or claude")
	flag.StringVar(&o.workspace, "workspace", "", "workspace path")
	flag.StringVar(&o.provider, "provider-instance", "", "T3 provider instance")
	flag.StringVar(&o.t3Home, "t3-home", "", "T3 home directory")
	flag.StringVar(&o.dbPath, "db", "", "T3 state database path")
	flag.StringVar(&o.attachmentsDir, "attachments-dir", "", "T3 attachments directory")
	flag.StringVar(&o.mode, "mode", "auto", "auto, sync, or replace")
	noCacheReset := flag.Bool("no-cache-reset", false, "keep T3 UI cache after changes")
	flag.Parse()
	o.resetCache = !*noCacheReset
	return o
}
func main() {
	opts := parseOptions()
	if opts.mode != "auto" && opts.mode != "sync" && opts.mode != "replace" {
		fmt.Fprintln(os.Stderr, "--mode must be auto, sync, or replace")
		os.Exit(2)
	}
	p := tea.NewProgram(initial(opts), tea.WithAltScreen(), tea.WithMouseAllMotion())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
