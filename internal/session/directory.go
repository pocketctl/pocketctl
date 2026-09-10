package session

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"golang.org/x/sys/unix"
)

const maxDirectoryEntries = 100000

type directoryCursor struct {
	Path     string
	Query    string
	After    string
	Modified int64
}

// directoryAccess consults the OS (including ACLs), not just Unix mode bits.
// This does not write probe files into directories during browsing.
func directoryAccess(path string) (browse, write bool) {
	browse = unix.Access(path, unix.R_OK|unix.X_OK) == nil
	return browse, browse && unix.Access(path, unix.W_OK|unix.X_OK) == nil
}

func (sm *SessionManager) DirectoryQuery(ctx context.Context, cmd protocol.ClientMessage) protocol.DaemonEvent {
	sm.mu.RLock()
	policy := sm.cwdPolicy
	sm.mu.RUnlock()
	return policy.DirectoryQuery(ctx, cmd)
}

func (p *CwdPolicy) DirectoryQuery(ctx context.Context, cmd protocol.ClientMessage) protocol.DaemonEvent {
	event := protocol.DaemonEvent{Type: "directory_result", RequestID: cmd.RequestID, Operation: cmd.Type}
	fail := func(reason string) protocol.DaemonEvent { event.Reason = reason; return event }
	if ctx.Err() != nil {
		return fail("timeout")
	}
	roots := p.Roots()
	home, _ := os.UserHomeDir()
	result := &protocol.DirectoryResult{Roots: roots, Home: home, Entries: []protocol.DirectoryEntry{}}
	event.Directory = result
	if len(roots) == 0 {
		return fail("cwd_not_authorized")
	}
	if len(cmd.Path) > 8192 || len(cmd.Query) > 256 || len(cmd.Cursor) > 16384 {
		return fail("invalid_request")
	}
	raw := cmd.Path
	if raw == "" || raw == "~" {
		raw = home
	} else if strings.HasPrefix(raw, "~/") {
		raw = filepath.Join(home, raw[2:])
	}
	if !filepath.IsAbs(raw) {
		return fail("invalid_path")
	}
	path, err := p.AuthorizeProposed(raw)
	if err != nil {
		return fail("cwd_not_authorized")
	}
	for {
		info, err := os.Stat(path)
		if err == nil {
			if !info.IsDir() {
				return fail("not_directory")
			}
			break
		}
		if !os.IsNotExist(err) {
			return fail("permission_denied")
		}
		if cmd.Type != "list_directories" || !cmd.Fallback || cmd.Cursor != "" {
			return fail("not_found")
		}
		parent := filepath.Dir(path)
		_, parentErr := p.AuthorizeProposed(parent)
		if parent == path || parentErr != nil {
			return fail("not_found")
		}
		path = parent
		result.Fallback = true
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil || p.Allows(canonical) != nil {
		return fail("cwd_not_authorized")
	}
	result.Path = canonical
	parent := filepath.Dir(canonical)
	if parent != canonical && p.Allows(parent) == nil {
		result.Parent = parent
	}
	result.CanBrowse, result.CanSelect = directoryAccess(canonical)
	if !result.CanBrowse {
		result.Reason = "permission_denied"
	} else if !result.CanSelect {
		result.Reason = "read_only"
	}
	if cmd.Type == "validate_directory" {
		if !result.CanSelect {
			return fail(result.Reason)
		}
		return event
	}
	if !result.CanBrowse {
		return fail("permission_denied")
	}
	f, err := p.openDirectory(canonical)
	if err != nil {
		return fail("permission_denied")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return fail("not_found")
	}
	stamp := info.ModTime().UnixNano()
	after := ""
	if cmd.Cursor != "" {
		b, err := base64.RawURLEncoding.DecodeString(cmd.Cursor)
		var cursor directoryCursor
		if err != nil || json.Unmarshal(b, &cursor) != nil || cursor.Path != canonical || cursor.Query != cmd.Query || cursor.Modified != stamp {
			return fail("stale_cursor")
		}
		after = cursor.After
	}
	limit := cmd.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 200 {
		limit = 200
	}
	// Scan a single level in chunks. Retain at most limit+1 candidates, sorted
	// by raw filename, so pagination is stable without retaining a directory tree.
	candidates := []string{}
	scanned := 0
	for {
		if ctx.Err() != nil {
			return fail("timeout")
		}
		batch, err := f.ReadDir(256)
		for _, entry := range batch {
			scanned++
			if scanned > maxDirectoryEntries {
				return fail("directory_too_large")
			}
			name := entry.Name()
			if name <= after || !strings.Contains(strings.ToLower(name), strings.ToLower(cmd.Query)) {
				continue
			}
			if !entry.IsDir() && entry.Type()&os.ModeSymlink == 0 {
				continue
			}
			child := filepath.Join(canonical, name)
			if entry.Type()&os.ModeSymlink != 0 {
				st, e := os.Stat(child)
				if e != nil || !st.IsDir() {
					continue
				}
			}
			candidates = append(candidates, name)
		}
		sort.Strings(candidates)
		if len(candidates) > limit+1 {
			candidates = candidates[:limit+1]
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fail("permission_denied")
		}
	}
	for _, name := range candidates[:min(limit, len(candidates))] {
		if ctx.Err() != nil {
			return fail("timeout")
		}
		child := filepath.Join(canonical, name)
		entry := protocol.DirectoryEntry{Name: name, Path: child}
		if p.Allows(child) != nil {
			entry.Reason = "cwd_not_authorized"
		} else {
			entry.CanBrowse, entry.CanSelect = directoryAccess(child)
			if !entry.CanBrowse {
				entry.Reason = "permission_denied"
			} else if !entry.CanSelect {
				entry.Reason = "read_only"
			}
		}
		result.Entries = append(result.Entries, entry)
	}
	if len(candidates) > limit {
		b, _ := json.Marshal(directoryCursor{canonical, cmd.Query, candidates[limit-1], stamp})
		result.NextCursor = base64.RawURLEncoding.EncodeToString(b)
	}
	// Reject a changed directory instead of silently skipping/duplicating pages.
	if p.Allows(canonical) != nil {
		return fail("cwd_not_authorized")
	}
	current, e := f.Stat()
	if e != nil || current.ModTime().UnixNano() != stamp {
		return fail("stale_cursor")
	}
	return event
}

// Root.Open confines resolution while opening, including concurrent symlink
// replacements between authorization and open (Go's traversal-resistant API).
func (p *CwdPolicy) openDirectory(path string) (*os.File, error) {
	for _, allowed := range p.Roots() {
		if !isSubPath(allowed, path) {
			continue
		}
		root, err := os.OpenRoot(allowed)
		if err != nil {
			return nil, err
		}
		defer root.Close()
		rel, err := filepath.Rel(allowed, path)
		if err != nil {
			return nil, err
		}
		return root.Open(rel)
	}
	return nil, ErrCwdNotAuthorized
}
