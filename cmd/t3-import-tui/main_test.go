package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/CarlosGtrz/t3-import/internal/app"
	tea "github.com/charmbracelet/bubbletea"
)

func item(id, status string, selectable bool) preview {
	p := preview{}
	p.Summary.ID, p.Summary.Title = id, id
	p.Sync.Status, p.Sync.Selectable = status, selectable
	p.Replacement.Status, p.Replacement.Selectable = "replaceable", status == "history-diverged"
	return p
}

func TestSelectionEligibilityAndSearch(t *testing.T) {
	m := model{mode: "auto", items: []preview{item("new", "new", true), item("changed", "history-diverged", false), item("done", "up-to-date", false)}, selected: map[string]bool{}}
	if !m.eligible(m.items[0]) || !m.eligible(m.items[1]) || m.eligible(m.items[2]) {
		t.Fatal("unexpected auto selection eligibility")
	}
	m.selected["new"] = true
	if m.eligible(m.items[1]) {
		t.Fatal("selection should not mix import and replacement operations")
	}
	m.selected = map[string]bool{}
	m.query = "done"
	if got := m.visible(); len(got) != 1 || got[0].Summary.ID != "done" {
		t.Fatalf("search results = %#v", got)
	}
}

func TestConfirmedWriteCannotBeInterrupted(t *testing.T) {
	cancelled := false
	m := model{stage: "execute", busy: true, writing: true, cancel: func() { cancelled = true }}
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if cmd != nil || !next.(model).busy || cancelled {
		t.Fatal("Escape interrupted a confirmed write")
	}
}

func TestReadCanBeCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	m := model{stage: "preview", busy: true, cancel: cancel}
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if cmd != nil {
		t.Fatal("cancellation unexpectedly started another command")
	}
	if ctx.Err() != context.Canceled {
		t.Fatal("Escape did not cancel the read")
	}
}

type serviceFunc func(context.Context, app.Request) (json.RawMessage, error)

func (f serviceFunc) Call(ctx context.Context, request app.Request) (json.RawMessage, error) {
	return f(ctx, request)
}

func TestAsyncServiceCommandPassesNativeRequestAndDecodesResult(t *testing.T) {
	service := serviceFunc(func(_ context.Context, request app.Request) (json.RawMessage, error) {
		if request.Action != "preview" || request.Source != "codex" || request.Workspace != "/repo" {
			t.Fatalf("unexpected service request: %+v", request)
		}
		return json.RawMessage(`{"sessions":[{"summary":{"id":"s1","title":"Session"}}]}`), nil
	})
	cmd, cancel := invoke(service, app.Request{Action: "preview", Source: "codex", Workspace: "/repo"})
	defer cancel()
	msg := cmd().(serviceMsg)
	if msg.err != nil || len(msg.data.Sessions) != 1 || msg.data.Sessions[0].Summary.ID != "s1" {
		t.Fatalf("native service response was not decoded: %+v", msg)
	}
}

func TestLaunchChoiceAndNavigation(t *testing.T) {
	m := model{stage: "result", cursor: 0, launchChoice: 0}
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyDown})
	updated := next.(model)
	if updated.cursor != 1 || updated.launchChoice != 1 {
		t.Fatalf("selection=%d launch=%d", updated.cursor, updated.launchChoice)
	}
	if !strings.Contains(updated.View(), "> [ Exit ]") {
		t.Fatalf("result view did not highlight the selected exit action: %s", updated.View())
	}
}

func TestMouseSelectionAndWheelNavigation(t *testing.T) {
	m := model{stage: "sessions", mode: "sync", items: []preview{item("one", "syncable", true), item("two", "syncable", true), item("three", "syncable", true), item("four", "syncable", true)}, selected: map[string]bool{}, width: 80, height: 18}
	next, _ := m.Update(tea.MouseMsg{X: 10, Y: m.listTop() + 2, Action: tea.MouseActionMotion})
	m = next.(model)
	if m.hover != 2 {
		t.Fatalf("mouse hover row=%d, want 2", m.hover)
	}
	next, _ = m.Update(tea.MouseMsg{X: 10, Y: m.listTop() + 1, Action: tea.MouseActionPress, Button: tea.MouseButtonLeft})
	m = next.(model)
	if !m.selected["two"] || m.cursor != 1 {
		t.Fatalf("mouse click did not select row two: cursor=%d selected=%v", m.cursor, m.selected)
	}
	next, _ = m.Update(tea.MouseMsg{X: 10, Y: 8, Action: tea.MouseActionPress, Button: tea.MouseButtonWheelDown})
	m = next.(model)
	if m.cursor <= 1 {
		t.Fatalf("wheel down did not advance the list cursor: %d", m.cursor)
	}
}

func TestMouseWheelScrollsLongResults(t *testing.T) {
	m := model{stage: "result", width: 80, height: 12, rawResult: json.RawMessage(`{"imported":{"results":[{"status":"imported","title":"one"},{"status":"imported","title":"two"},{"status":"imported","title":"three"},{"status":"imported","title":"four"},{"status":"imported","title":"five"},{"status":"imported","title":"six"}]}}`)}
	next, _ := m.Update(tea.MouseMsg{X: 20, Y: 8, Action: tea.MouseActionPress, Button: tea.MouseButtonWheelDown})
	if next.(model).scroll == 0 {
		t.Fatal("mouse wheel did not scroll the result view")
	}
}

func TestMouseReviewActionsAndResize(t *testing.T) {
	m := model{stage: "review", source: "codex", workspace: "/repo", mode: "auto", selected: map[string]bool{"session": true}, width: 80, height: 20}
	next, cmd := m.Update(tea.MouseMsg{X: 5, Y: 19, Action: tea.MouseActionPress, Button: tea.MouseButtonLeft})
	updated := next.(model)
	if cmd == nil || updated.stage != "execute" || !updated.busy || !updated.writing {
		t.Fatalf("confirm click did not start protected write: model=%+v cmd=%v", updated, cmd)
	}
	m = model{stage: "review", selected: map[string]bool{"session": true}, width: 80, height: 20}
	next, cmd = m.Update(tea.MouseMsg{X: 70, Y: 19, Action: tea.MouseActionPress, Button: tea.MouseButtonLeft})
	if next.(model).stage != "sessions" || cmd != nil {
		t.Fatal("cancel click did not return to session selection")
	}
	next, _ = m.Update(tea.WindowSizeMsg{Width: 120, Height: 32})
	updated = next.(model)
	if updated.width != 120 || updated.height != 32 {
		t.Fatalf("resize was not recorded: %dx%d", updated.width, updated.height)
	}
}

func TestBackNavigationResetsScrollBeforeMouseSelection(t *testing.T) {
	m := model{
		stage: "sessions", scroll: 2, width: 80, height: 18,
		workspaces: []string{"first", "second", "third"},
		selected:   map[string]bool{},
	}
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	m = next.(model)
	if m.stage != "workspace" || m.scroll != 0 {
		t.Fatalf("back navigation left workspace at stage=%s scroll=%d", m.stage, m.scroll)
	}
	next, _ = m.Update(tea.MouseMsg{X: 10, Y: m.listTop(), Action: tea.MouseActionPress, Button: tea.MouseButtonLeft})
	if next.(model).workspace != "first" {
		t.Fatalf("first visible workspace click selected %q", next.(model).workspace)
	}
}

func TestReviewShowsSelectedConversationAndChangePreview(t *testing.T) {
	p := item("session-1", "syncable", true)
	p.Summary.Title = "Important conversation"
	p.Sync.NewTurns = 2
	m := model{
		stage: "review", source: "codex", workspace: "/repo", mode: "sync",
		items: []preview{p}, selected: map[string]bool{"session-1": true}, width: 100, height: 24,
	}
	view := m.View()
	if !strings.Contains(view, "Important conversation") || !strings.Contains(view, "2 new turns") {
		t.Fatalf("review omitted selected item details: %s", view)
	}
}

func TestReviewShowsImportCounts(t *testing.T) {
	p := item("session-1", "new", true)
	p.Summary.Title = "New conversation"
	p.ImportPreview = importPreview{Tasks: 1, Turns: 2, Messages: 3, Activities: 4, Attachments: 1}
	m := model{stage: "review", source: "codex", workspace: "/repo", mode: "auto", items: []preview{p}, selected: map[string]bool{"session-1": true}, width: 100, height: 24}
	view := m.View()
	for _, want := range []string{"New conversation", "Import 1 task · 2 turns · 3 messages · 4 activities · 1 attachment"} {
		if !strings.Contains(view, want) {
			t.Fatalf("review omitted %q: %s", want, view)
		}
	}
}

func TestReviewShowsReplacementTargetAndCounts(t *testing.T) {
	p := item("session-1", "history-diverged", false)
	p.Summary.Title = "Changed conversation"
	p.Replacement.OldThreadID = "old-task"
	p.Replacement.NewThreadID = "new-task"
	p.Replacement.Turns, p.Replacement.Events, p.Replacement.Attachments = 2, 5, 1
	m := model{stage: "review", source: "codex", workspace: "/repo", mode: "replace", items: []preview{p}, selected: map[string]bool{"session-1": true}, width: 100, height: 24}
	view := m.View()
	for _, want := range []string{"Changed conversation · session-1", "Existing T3 task(s): old-task", "New T3 task: new-task", "Replace with 2 turns · 5 events · 1 attachment"} {
		if !strings.Contains(view, want) {
			t.Fatalf("replacement review omitted %q: %s", want, view)
		}
	}
}

func TestReviewCanScrollThroughEverySelectedConversation(t *testing.T) {
	items := make([]preview, 5)
	selected := make(map[string]bool)
	for i := range items {
		id := fmt.Sprintf("session-%d", i)
		items[i] = item(id, "syncable", true)
		items[i].Summary.Title = fmt.Sprintf("Conversation %d", i)
		items[i].Sync.NewTurns = i + 1
		selected[id] = true
	}
	m := model{stage: "review", mode: "sync", items: items, selected: selected, width: 80, height: 12}
	if strings.Contains(m.View(), "Conversation 4 · session-4") {
		t.Fatal("last selected conversation unexpectedly fit in the initial viewport")
	}
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyPgDown})
	m = next.(model)
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyPgDown})
	m = next.(model)
	if m.scroll == 0 || !strings.Contains(m.View(), "Conversation 4 · session-4") {
		t.Fatalf("page navigation did not reveal the last selected conversation: scroll=%d view=%s", m.scroll, m.View())
	}
	scrolled := m.scroll
	next, _ = m.Update(tea.MouseMsg{X: 20, Y: 8, Action: tea.MouseActionPress, Button: tea.MouseButtonWheelUp})
	if next.(model).scroll >= scrolled {
		t.Fatalf("mouse wheel did not scroll the review body upward: before=%d after=%d", scrolled, next.(model).scroll)
	}
}

func TestResultShowsDatabaseAndCacheBackupPaths(t *testing.T) {
	m := model{
		stage: "result", width: 100, height: 24,
		rawResult: json.RawMessage(`{"imported":{"backup":"/t3/backups/state.sqlite.bak","cache":{"backup":"/t3/backups/cache.bak"},"results":[{"status":"imported","title":"conversation"}]}}`),
	}
	view := m.View()
	if !strings.Contains(view, "/t3/backups/state.sqlite.bak") || !strings.Contains(view, "/t3/backups/cache.bak") {
		t.Fatalf("result omitted recovery backup paths: %s", view)
	}
}

func TestSpinnerTickOnlyAnimatesWhileBusy(t *testing.T) {
	m := model{busy: true}
	next, cmd := m.Update(spinnerTickMsg(time.Now()))
	if next.(model).frame != 1 || cmd == nil {
		t.Fatal("busy spinner did not advance and schedule its next frame")
	}
	m = next.(model)
	m.busy = false
	next, cmd = m.Update(spinnerTickMsg(time.Now()))
	if next.(model).frame != 1 || cmd != nil {
		t.Fatal("spinner kept animating after the operation completed")
	}
}

func TestViewUsesResponsiveStyledLayoutAndPresentsActions(t *testing.T) {
	m := model{stage: "sessions", mode: "auto", items: []preview{item("session", "new", true)}, selected: map[string]bool{}, width: 72, height: 16}
	view := m.View()
	if !strings.Contains(view, "T3") || !strings.Contains(view, "new") || !strings.Contains(view, "Space select") {
		t.Fatalf("unexpected session view: %s", view)
	}
	m.stage, m.selected = "review", map[string]bool{"session": true}
	view = m.View()
	if !strings.Contains(view, "Confirm write") || !strings.Contains(view, "Cancel") {
		t.Fatalf("review actions are missing: %s", view)
	}
}
