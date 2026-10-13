// Package launch resolves and starts the installed T3 Code application.
package launch

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

// Command describes an executable and its arguments used to launch T3 Code.
type Command struct {
	Command string
	Args    []string
}

// ResolveT3Launch resolves T3 Code's launch command for platform. Environment
// and userHome are explicit so callers can test discovery without host state.
func ResolveT3Launch(environment map[string]string, platform, userHome string) (Command, error) {
	if override := strings.TrimSpace(environment["T3_CODE_BIN"]); override != "" {
		return Command{Command: override}, nil
	}
	switch platform {
	case "win32", "windows":
		if executable := windowsExecutable(environment); executable != "" {
			return Command{Command: executable}, nil
		}
		return Command{}, errors.New("T3 Code is not installed under the standard Windows Programs directory. Set T3_CODE_BIN to its executable path.")
	case "darwin", "macos":
		if app := macApplication(userHome); app != "" {
			return Command{Command: "open", Args: []string{app}}, nil
		}
		return Command{Command: "open", Args: []string{"-b", "com.t3tools.t3code"}}, nil
	default:
		return Command{Command: "t3code"}, nil
	}
}

// LaunchT3Code starts T3 Code detached from the current process.
func LaunchT3Code() error {
	home, _ := os.UserHomeDir()
	command, err := ResolveT3Launch(environment(), runtime.GOOS, home)
	if err != nil {
		return err
	}
	cmd := exec.Command(command.Command, command.Args...)
	cmd.Stdout, cmd.Stderr, cmd.Stdin = nil, nil, nil
	configureDetached(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("unable to start T3 Code with %s: %w", filepath.Base(command.Command), err)
	}
	// Do not wait: the launched application must outlive this process.
	return nil
}

func environment() map[string]string {
	values := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			values[key] = value
		}
	}
	return values
}

func windowsExecutable(environment map[string]string) string {
	roots := []string{}
	for _, root := range []string{
		joinIfSet(environment["LOCALAPPDATA"], "Programs", "t3code"),
		joinIfSet(environment["ProgramFiles"], "t3code"),
		joinIfSet(environment["ProgramFiles(x86)"], "t3code"),
	} {
		if root != "" {
			roots = append(roots, root)
		}
	}
	preferred := []string{"T3 Code (Nightly).exe", "T3 Code.exe", "T3 Code (Alpha).exe"}
	for _, root := range roots {
		for _, name := range preferred {
			candidate := filepath.Join(root, name)
			if exists(candidate) {
				return candidate
			}
		}
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		names := []string{}
		for _, entry := range entries {
			name := entry.Name()
			if windowsAppPattern.MatchString(name) && !strings.HasPrefix(strings.ToLower(name), "uninstall ") {
				names = append(names, name)
			}
		}
		sort.Strings(names)
		if len(names) > 0 {
			return filepath.Join(root, names[0])
		}
	}
	return ""
}

var windowsAppPattern = regexp.MustCompile(`(?i)^T3 Code.*\.exe$`)

func macApplication(userHome string) string {
	names := []string{"T3 Code (Nightly).app", "T3 Code.app", "T3 Code (Alpha).app"}
	roots := []string{"/Applications"}
	if userHome != "" {
		roots = append(roots, filepath.Join(userHome, "Applications"))
	}
	for _, root := range roots {
		for _, name := range names {
			candidate := filepath.Join(root, name)
			if exists(candidate) {
				return candidate
			}
		}
	}
	return ""
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func joinIfSet(root string, parts ...string) string {
	if root == "" {
		return ""
	}
	return filepath.Join(append([]string{root}, parts...)...)
}
