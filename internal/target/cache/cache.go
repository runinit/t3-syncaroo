// Package cache discovers and safely resets T3's rebuildable IndexedDB cache.
package cache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	goruntime "runtime"
	"sort"
	"strings"
	"time"

	"github.com/runinit/t3-syncaroo/internal/domain"
	"github.com/runinit/t3-syncaroo/internal/target/config"
	t3runtime "github.com/runinit/t3-syncaroo/internal/target/runtime"
)

var profileNames = []string{"t3code-v2", "T3 Code (Alpha)", "T3 Code (Nightly)", "T3 Code", "t3code"}
var cacheNames = []string{"t3code_app_0.indexeddb.leveldb", "t3code_app_0.indexeddb.blob"}

// FileSystem is the filesystem seam used for discovery and transactional reset.
type FileSystem interface {
	Lstat(string) (fs.FileInfo, error)
	ReadDir(string) ([]fs.DirEntry, error)
	Open(string) (io.ReadCloser, error)
	Mkdir(string, fs.FileMode) error
	MkdirAll(string, fs.FileMode) error
	Rename(string, string) error
	RemoveAll(string) error
	Create(string) (io.WriteCloser, error)
}

type osFS struct{}

func (osFS) Lstat(p string) (fs.FileInfo, error)     { return os.Lstat(p) }
func (osFS) ReadDir(p string) ([]fs.DirEntry, error) { return os.ReadDir(p) }
func (osFS) Open(p string) (io.ReadCloser, error)    { return os.Open(p) }
func (osFS) Mkdir(p string, m fs.FileMode) error     { return os.Mkdir(p, m) }
func (osFS) MkdirAll(p string, m fs.FileMode) error  { return os.MkdirAll(p, m) }
func (osFS) Rename(a, b string) error                { return os.Rename(a, b) }
func (osFS) RemoveAll(p string) error                { return os.RemoveAll(p) }
func (osFS) Create(p string) (io.WriteCloser, error) {
	return os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
}

type Options struct {
	Environment map[string]string
	Platform    string
	UserHome    string
	FS          FileSystem
}

type Profile struct {
	ProfilePath string
	CachePaths  []string
	ModifiedAt  time.Time
}

func (o Options) defaults() Options {
	if o.Environment == nil {
		o.Environment = map[string]string{}
		for _, e := range os.Environ() {
			if i := strings.IndexByte(e, '='); i >= 0 {
				o.Environment[e[:i]] = e[i+1:]
			}
		}
	}
	if o.Platform == "" {
		o.Platform = goruntime.GOOS
	}
	if o.UserHome == "" {
		o.UserHome, _ = os.UserHomeDir()
	}
	if o.FS == nil {
		o.FS = osFS{}
	}
	return o
}

func Discover(options Options) ([]Profile, error) {
	o := options.defaults()
	base := ""
	switch o.Platform {
	case "win32", "windows":
		base = o.Environment["APPDATA"]
	case "darwin":
		base = filepath.Join(o.UserHome, "Library", "Application Support")
	default:
		base = strings.TrimSpace(o.Environment["XDG_CONFIG_HOME"])
		if base == "" {
			base = filepath.Join(o.UserHome, ".config")
		}
	}
	if override := strings.TrimSpace(o.Environment["T3_CODE_USER_DATA"]); override != "" {
		base = filepath.Clean(override)
		return discoverPaths(o, []string{base})
	}
	paths := make([]string, 0, len(profileNames))
	if base != "" {
		for _, n := range profileNames {
			paths = append(paths, filepath.Join(base, n))
		}
	}
	return discoverPaths(o, paths)
}
func discoverPaths(o Options, paths []string) ([]Profile, error) {
	var found []Profile
	for _, p := range paths {
		db := filepath.Join(p, "IndexedDB")
		var caches []string
		newest := time.Time{}
		for _, n := range cacheNames {
			q := filepath.Join(db, n)
			if _, err := o.FS.Lstat(q); err == nil {
				caches = append(caches, q)
				t, e := newestTime(o.FS, q)
				if e != nil {
					return nil, e
				}
				if t.After(newest) {
					newest = t
				}
			} else if !os.IsNotExist(err) {
				return nil, err
			}
		}
		if len(caches) > 0 {
			found = append(found, Profile{p, caches, newest})
		}
	}
	sort.SliceStable(found, func(i, j int) bool { return found[i].ModifiedAt.After(found[j].ModifiedAt) })
	return found, nil
}
func newestTime(f FileSystem, p string) (time.Time, error) {
	st, e := f.Lstat(p)
	if e != nil {
		return time.Time{}, e
	}
	newest := st.ModTime()
	if st.IsDir() && st.Mode()&fs.ModeSymlink == 0 {
		entries, e := f.ReadDir(p)
		if e != nil {
			return time.Time{}, e
		}
		for _, ent := range entries {
			t, e := newestTime(f, filepath.Join(p, ent.Name()))
			if e != nil {
				return time.Time{}, e
			}
			if t.After(newest) {
				newest = t
			}
		}
	}
	return newest, nil
}

func Reset(ctx context.Context, paths config.TargetPaths, options Options) (domain.CacheResetResult, error) {
	if _, err := t3runtime.AssertT3Closed(ctx, paths); err != nil {
		return domain.CacheResetResult{}, err
	}
	o := options.defaults()
	profiles, err := Discover(o)
	if err != nil {
		return domain.CacheResetResult{}, err
	}
	if len(profiles) == 0 {
		return domain.CacheResetResult{Status: domain.CacheNotFound, Entries: []string{}, Warnings: []string{}}, nil
	}
	p := profiles[0]
	db := filepath.Join(p.ProfilePath, "IndexedDB")
	resolvedDB, err := filepath.Abs(db)
	if err != nil {
		return domain.CacheResetResult{}, err
	}
	names := make([]string, 0, len(p.CachePaths))
	for _, c := range p.CachePaths {
		resolved, e := filepath.Abs(c)
		if e != nil {
			return domain.CacheResetResult{}, e
		}
		rel, e := filepath.Rel(resolvedDB, resolved)
		if e != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return domain.CacheResetResult{}, fmt.Errorf("refusing to reset cache outside T3 IndexedDB directory: %s", c)
		}
		names = append(names, filepath.Base(c))
	}
	stamp := time.Now().UTC().Format("2006-01-02T15-04-05.000Z")
	backup := filepath.Join(paths.StateDir, "t3-import-backups", "indexeddb-before-cache-reset-"+stamp)
	backupProfile := filepath.Join(backup, filepath.Base(p.ProfilePath))
	staging := filepath.Join(p.ProfilePath, ".t3-import-cache-reset-"+fmt.Sprintf("%d", time.Now().UnixNano()))
	if err = o.FS.Mkdir(staging, 0700); err != nil {
		return domain.CacheResetResult{}, err
	}
	moved := []string{}
	rollback := func(cause error) (domain.CacheResetResult, error) {
		var restore error
		for i := len(moved) - 1; i >= 0; i-- {
			src := filepath.Join(staging, moved[i])
			dst := filepath.Join(db, moved[i])
			if _, e := o.FS.Lstat(src); e == nil {
				_ = o.FS.RemoveAll(dst)
				if e = o.FS.Rename(src, dst); e != nil {
					restore = e
					break
				}
			}
		}
		if restore == nil {
			_ = o.FS.RemoveAll(staging)
			_ = o.FS.RemoveAll(backup)
			return domain.CacheResetResult{}, fmt.Errorf("unable to reset T3 IndexedDB cache: %w", cause)
		}
		return domain.CacheResetResult{}, fmt.Errorf("unable to reset T3 IndexedDB cache: %v; restoration failed: %v; recovery files preserved in %s", cause, restore, staging)
	}
	for _, n := range names {
		if err = o.FS.Rename(filepath.Join(db, n), filepath.Join(staging, n)); err != nil {
			return rollback(err)
		}
		moved = append(moved, n)
	}
	if err = o.FS.MkdirAll(backupProfile, 0700); err != nil {
		return rollback(err)
	}
	for _, n := range moved {
		if err = copyVerified(o.FS, filepath.Join(staging, n), filepath.Join(backupProfile, n)); err != nil {
			return rollback(err)
		}
	}
	if err = o.FS.RemoveAll(staging); err != nil {
		return rollback(err)
	}
	warnings := []string{}
	if len(profiles) > 1 {
		noun := "caches were"
		if len(profiles) == 2 {
			noun = "cache was"
		}
		warnings = append(warnings, fmt.Sprintf("Reset the most recently used T3 profile; %d older profile %s left untouched.", len(profiles)-1, noun))
	}
	return domain.CacheResetResult{Status: domain.CacheReset, Backup: &backup, Profile: &p.ProfilePath, Entries: names, Warnings: warnings}, nil
}

type digestFile struct {
	path, hash string
	size       int64
}

func manifest(f FileSystem, p, root string) ([]digestFile, error) {
	st, e := f.Lstat(p)
	if e != nil {
		return nil, e
	}
	if st.Mode()&fs.ModeSymlink != 0 {
		return nil, fmt.Errorf("refusing to back up symbolic link in T3 cache: %s", p)
	}
	if st.Mode().IsRegular() {
		r, e := f.Open(p)
		if e != nil {
			return nil, e
		}
		h := sha256.New()
		_, e = io.Copy(h, r)
		ce := r.Close()
		if e == nil {
			e = ce
		}
		if e != nil {
			return nil, e
		}
		return []digestFile{{strings.TrimPrefix(strings.TrimPrefix(p, root), string(filepath.Separator)), hex.EncodeToString(h.Sum(nil)), st.Size()}}, nil
	}
	if !st.IsDir() {
		return nil, fmt.Errorf("unsupported T3 cache entry: %s", p)
	}
	ents, e := f.ReadDir(p)
	if e != nil {
		return nil, e
	}
	var out []digestFile
	for _, x := range ents {
		v, e := manifest(f, filepath.Join(p, x.Name()), root)
		if e != nil {
			return nil, e
		}
		out = append(out, v...)
	}
	return out, nil
}
func copyVerified(f FileSystem, src, dst string) error {
	if err := copyTree(f, src, dst); err != nil {
		return err
	}
	a, e := manifest(f, src, src)
	if e != nil {
		return e
	}
	b, e := manifest(f, dst, dst)
	if e != nil {
		return e
	}
	sort.Slice(a, func(i, j int) bool { return a[i].path < a[j].path })
	sort.Slice(b, func(i, j int) bool { return b[i].path < b[j].path })
	if fmt.Sprint(a) != fmt.Sprint(b) {
		return fmt.Errorf("T3 cache backup verification failed: %s", dst)
	}
	return nil
}
func copyTree(f FileSystem, src, dst string) error {
	st, e := f.Lstat(src)
	if e != nil {
		return e
	}
	if st.Mode()&fs.ModeSymlink != 0 {
		return fmt.Errorf("refusing to back up symbolic link in T3 cache: %s", src)
	}
	if st.IsDir() {
		if e = f.Mkdir(dst, 0700); e != nil {
			return e
		}
		ents, e := f.ReadDir(src)
		if e != nil {
			return e
		}
		for _, ent := range ents {
			if e = copyTree(f, filepath.Join(src, ent.Name()), filepath.Join(dst, ent.Name())); e != nil {
				return e
			}
		}
		return nil
	}
	if !st.Mode().IsRegular() {
		return fmt.Errorf("unsupported T3 cache entry: %s", src)
	}
	r, e := f.Open(src)
	if e != nil {
		return e
	}
	defer r.Close()
	w, e := f.Create(dst)
	if e != nil {
		return e
	}
	_, e = io.Copy(w, r)
	ce := w.Close()
	if e != nil {
		return e
	}
	return ce
}

func Format(result domain.CacheResetResult) string {
	if result.Status == domain.CacheNotFound {
		return "No T3 IndexedDB cache was found. Nothing was changed."
	}
	lines := []string{"T3 IndexedDB cache reset successfully."}
	if result.Profile != nil {
		lines = append(lines, "Profile: "+*result.Profile)
	}
	if result.Backup != nil {
		lines = append(lines, "Backup: "+*result.Backup)
	}
	lines = append(lines, fmt.Sprintf("Entries removed: %d", len(result.Entries)))
	for _, e := range result.Entries {
		lines = append(lines, "  - "+e)
	}
	for _, w := range result.Warnings {
		lines = append(lines, "Warning: "+w)
	}
	return strings.Join(lines, "\n")
}
