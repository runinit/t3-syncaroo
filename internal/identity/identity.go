// Package identity contains the stable hashes and path normalization used by
// importer-owned IDs and ledgers.
package identity

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func SHA256(value []byte) string {
	hash := sha256.Sum256(value)
	return hex.EncodeToString(hash[:])
}

func SHA256String(value string) string { return SHA256([]byte(value)) }

// UUID derives the same version-5-shaped deterministic identifier used by the
// TypeScript implementation (first 16 SHA-256 bytes with UUID version bits).
func UUID(seed string) string {
	hash := sha256.Sum256([]byte(seed))
	b := append([]byte(nil), hash[:16]...)
	b[6] = (b[6] & 0x0f) | 0x50
	b[8] = (b[8] & 0x3f) | 0x80
	value := hex.EncodeToString(b)
	return value[:8] + "-" + value[8:12] + "-" + value[12:16] + "-" + value[16:20] + "-" + value[20:]
}

func CanonicalPath(input string) string {
	absolute := input
	if !filepath.IsAbs(absolute) {
		if resolved, err := filepath.Abs(absolute); err == nil {
			absolute = resolved
		}
	}
	absolute = filepath.Clean(absolute)
	if resolved, err := filepath.EvalSymlinks(absolute); err == nil {
		absolute = resolved
	}
	absolute = strings.TrimRight(absolute, `/\`)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		absolute = strings.ToLower(absolute)
	}
	return absolute
}

func TargetID(dbPath string) string { return SHA256String(CanonicalPath(dbPath)) }

func ThreadID(sourceKey, sessionID string, codexSessionID bool) string {
	if codexSessionID && isUUID(sessionID) {
		return strings.ToLower(sessionID)
	}
	return UUID("t3-import:thread:" + sourceKey)
}

func ProjectID(workspace string) string { return UUID("t3-import:project:" + CanonicalPath(workspace)) }

func isUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for i, r := range value {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			continue
		}
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F') {
			return false
		}
	}
	return true
}

func Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
