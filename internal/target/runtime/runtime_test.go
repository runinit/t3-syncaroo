package runtime

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/runinit/t3-syncaroo/internal/target/config"
)

func TestInspectRuntimeAbsentMalformedAndOrigin(t *testing.T) {
	path := filepath.Join(t.TempDir(), "server-runtime.json")
	paths := config.TargetPaths{RuntimeStatePath: path}
	if got := InspectRuntime(context.Background(), paths); got.Exists || got.Live || got.Stale {
		t.Fatalf("absent state: %+v", got)
	}
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := InspectRuntime(context.Background(), paths); !got.Exists || got.Live || !got.Stale {
		t.Fatalf("malformed state: %+v", got)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer server.Close()
	if err := os.WriteFile(path, []byte(`{"origin":"`+server.URL+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := InspectRuntime(context.Background(), paths); !got.Exists || !got.Live || got.Stale || got.Origin != server.URL {
		t.Fatalf("live origin state: %+v", got)
	}
}
