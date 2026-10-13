package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// appRequest is deliberately bounded and read-only. Codex rollout files remain
// the source of truth; the app-server only fills gaps in their metadata.
func appRequest(ctx context.Context, method string, params map[string]any, timeout time.Duration) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	bin := strings.TrimSpace(os.Getenv("CODEX_BIN"))
	if bin == "" {
		bin = "codex"
	}
	cmd := exec.CommandContext(ctx, bin, "app-server")
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = nil
	if err = cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan struct{})
	go func() { defer close(done); _ = cmd.Wait() }()
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 4096), 4*1024*1024)
	write := func(v any) error {
		b, e := json.Marshal(v)
		if e != nil {
			return e
		}
		_, e = fmt.Fprintf(in, "%s\n", b)
		return e
	}
	readID := func(id int) (map[string]any, error) {
		for sc.Scan() {
			var m map[string]any
			if json.Unmarshal(sc.Bytes(), &m) != nil {
				continue
			}
			if n, ok := m["id"].(float64); ok && int(n) == id {
				if m["error"] != nil {
					return nil, fmt.Errorf("app-server RPC error")
				}
				r, _ := m["result"].(map[string]any)
				return r, nil
			}
		}
		if err := sc.Err(); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("app-server closed response stream")
	}
	defer func() {
		_ = in.Close()
		select {
		case <-done:
		case <-time.After(100 * time.Millisecond):
			_ = cmd.Process.Kill()
			<-done
		}
	}()
	if err = write(map[string]any{"method": "initialize", "id": 1, "params": map[string]any{"clientInfo": map[string]any{"name": "t3_import", "title": "T3 Import", "version": "1.0.0"}, "capabilities": map[string]any{"experimentalApi": true}}}); err != nil {
		return nil, err
	}
	if _, err = readID(1); err != nil {
		return nil, err
	}
	_ = write(map[string]any{"method": "initialized", "params": map[string]any{}})
	if err = write(map[string]any{"method": method, "id": 2, "params": params}); err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	return readID(2)
}

func listAppThreads(ctx context.Context, workspace string) (map[string]map[string]any, error) {
	result := map[string]map[string]any{}
	var cursor any
	for page := 0; page < 20; page++ {
		p := map[string]any{"cursor": cursor, "limit": 100, "sortKey": "updated_at"}
		if workspace != "" {
			p["cwd"] = []string{workspace}
		}
		value, e := appRequest(ctx, "thread/list", p, 3*time.Second)
		if e != nil {
			return nil, e
		}
		r, _ := value.(map[string]any)
		if r == nil {
			return nil, fmt.Errorf("invalid thread/list response")
		}
		data, _ := r["data"].([]any)
		for _, v := range data {
			m, ok := v.(map[string]any)
			if ok {
				if id, _ := m["id"].(string); id != "" {
					result[id] = m
				}
			}
		}
		cursor, _ = r["nextCursor"].(string)
		if cursor == "" {
			break
		}
	}
	return result, nil
}

func readAppThread(ctx context.Context, id string) map[string]any {
	v, e := appRequest(ctx, "thread/read", map[string]any{"threadId": id, "includeTurns": true}, 2*time.Second)
	if e != nil {
		return nil
	}
	r, _ := v.(map[string]any)
	t, _ := r["thread"].(map[string]any)
	return t
}
