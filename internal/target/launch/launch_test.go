package launch

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveT3LaunchOverride(t *testing.T) {
	got, err := ResolveT3Launch(map[string]string{"T3_CODE_BIN": "  /custom/T3 Code  "}, "darwin", "")
	if err != nil {
		t.Fatal(err)
	}
	if got.Command != "/custom/T3 Code" || len(got.Args) != 0 {
		t.Fatalf("unexpected launch: %#v", got)
	}
}

func TestResolveT3LaunchWindowsDiscovery(t *testing.T) {
	localAppData := t.TempDir()
	root := filepath.Join(localAppData, "Programs", "t3code")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"T3 Code (Alpha).exe", "T3 Code (Nightly).exe", "T3 Code.exe", "T3 Code Beta.exe", "Uninstall T3 Code.exe"} {
		if err := os.WriteFile(filepath.Join(root, name), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	got, err := ResolveT3Launch(map[string]string{"LOCALAPPDATA": localAppData}, "win32", "")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, "T3 Code (Nightly).exe"); got.Command != want {
		t.Fatalf("command = %q, want preferred %q", got.Command, want)
	}
	if len(got.Args) != 0 {
		t.Fatalf("unexpected args: %#v", got.Args)
	}

	programFiles := t.TempDir()
	root = filepath.Join(programFiles, "t3code")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"T3 Code Zeta.exe", "T3 Code Beta.exe", "Uninstall T3 Code.exe"} {
		if err := os.WriteFile(filepath.Join(root, name), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	got, err = ResolveT3Launch(map[string]string{"ProgramFiles": programFiles}, "windows", "")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, "T3 Code Beta.exe"); got.Command != want {
		t.Fatalf("discovered command = %q, want %q", got.Command, want)
	}
}

func TestResolveT3LaunchWindowsMissing(t *testing.T) {
	_, err := ResolveT3Launch(map[string]string{}, "win32", "")
	if err == nil {
		t.Fatal("expected missing installation error")
	}
}

func TestResolveT3LaunchMacAndLinux(t *testing.T) {
	home := t.TempDir()
	apps := filepath.Join(home, "Applications")
	if err := os.MkdirAll(apps, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"T3 Code (Alpha).app", "T3 Code.app", "T3 Code (Nightly).app"} {
		if err := os.Mkdir(filepath.Join(apps, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	got, err := ResolveT3Launch(nil, "darwin", home)
	if err != nil {
		t.Fatal(err)
	}
	if got.Command != "open" || len(got.Args) != 1 || got.Args[0] != filepath.Join(apps, "T3 Code (Nightly).app") {
		t.Fatalf("unexpected macOS launch: %#v", got)
	}
	got, err = ResolveT3Launch(nil, "darwin", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if got.Command != "open" || len(got.Args) != 2 || got.Args[0] != "-b" || got.Args[1] != "com.t3tools.t3code" {
		t.Fatalf("unexpected macOS bundle fallback: %#v", got)
	}
	got, err = ResolveT3Launch(nil, "linux", "")
	if err != nil {
		t.Fatal(err)
	}
	if got.Command != "t3code" || len(got.Args) != 0 {
		t.Fatalf("unexpected Linux launch: %#v", got)
	}
}
