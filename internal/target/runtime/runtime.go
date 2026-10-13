// Package runtime performs read-only checks for a running T3 process.
package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"

	"github.com/runinit/t3-syncaroo/internal/target/config"
)

type RuntimeState struct {
	Exists bool   `json:"exists"`
	Live   bool   `json:"live"`
	PID    int    `json:"pid,omitempty"`
	Origin string `json:"origin,omitempty"`
	Stale  bool   `json:"stale"`
}

// InspectRuntime reads the runtime marker and probes its origin with a bounded
// request. It only sends an HTTP GET and never modifies T3-owned state.
func InspectRuntime(ctx context.Context, paths config.TargetPaths) RuntimeState {
	data, err := os.ReadFile(paths.RuntimeStatePath)
	if err != nil {
		return RuntimeState{Exists: false, Live: false, Stale: false}
	}
	state := RuntimeState{Exists: true, Stale: true}
	var value map[string]any
	if json.Unmarshal(data, &value) != nil || value == nil {
		return state
	}
	if pid, ok := number(value["pid"]); ok {
		state.PID = pid
	}
	if origin, ok := value["origin"].(string); ok && origin != "" {
		state.Origin = origin
	}
	if state.PID > 0 && processAlive(state.PID) {
		state.Live = true
	}
	if !state.Live && validOrigin(state.Origin) && originResponds(ctx, state.Origin) {
		state.Live = true
	}
	state.Stale = !state.Live
	return state
}

func AssertT3Closed(ctx context.Context, paths config.TargetPaths) (RuntimeState, error) {
	state := InspectRuntime(ctx, paths)
	if state.Live {
		message := "T3 is running"
		if state.PID != 0 {
			message += fmt.Sprintf(" (PID %d)", state.PID)
		}
		return state, fmt.Errorf("%s. Close T3 before importing.", message)
	}
	return state, nil
}

func number(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		if n > 0 && n == float64(int(n)) {
			return int(n), true
		}
	case json.Number:
		i, err := strconv.Atoi(n.String())
		return i, err == nil && i > 0
	}
	return 0, false
}
func validOrigin(origin string) bool {
	u, err := url.Parse(origin)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}
func originResponds(parent context.Context, origin string) bool {
	ctx, cancel := context.WithTimeout(parent, 700*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin, nil)
	if err != nil {
		return false
	}
	client := &http.Client{Timeout: 700 * time.Millisecond, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode > 0
}
