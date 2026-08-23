package session

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ErrCwdNotAuthorized is the stable reason surfaced to remote clients when a
// requested working directory is outside the daemon operator's configured
// allowed roots.
var ErrCwdNotAuthorized = errors.New("cwd_not_authorized")

func isCwdNotAuthorized(err error) bool {
	return errors.Is(err, ErrCwdNotAuthorized)
}

// CwdPolicy constrains where remotely created sessions may run. Roots are
// configured exclusively by the local daemon operator (CLI flags); the relay
// protocol carries no field that can extend them.
type CwdPolicy struct {
	roots []string // canonical, deduplicated, sorted longest-first
}

// NewCwdPolicy validates raw roots: each must be an absolute path to an
// existing directory (symlinks are resolved at construction). Nested roots
// collapse to their outermost ancestor. An empty root list constructs a
// fail-closed policy that authorizes nothing.
func NewCwdPolicy(rawRoots []string) (*CwdPolicy, error) {
	seen := make(map[string]struct{}, len(rawRoots))
	roots := make([]string, 0, len(rawRoots))
	for _, raw := range rawRoots {
		if raw == "" {
			continue
		}
		if !filepath.IsAbs(raw) {
			return nil, fmt.Errorf("allowed cwd root must be absolute: %s", raw)
		}
		info, err := os.Stat(raw)
		if err != nil {
			return nil, fmt.Errorf("allowed cwd root must exist: %s (%w)", raw, err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("allowed cwd root must be a directory: %s", raw)
		}
		resolved, err := filepath.EvalSymlinks(raw)
		if err != nil {
			return nil, fmt.Errorf("resolve allowed cwd root %s: %w", raw, err)
		}
		if _, dup := seen[resolved]; dup {
			continue
		}
		seen[resolved] = struct{}{}
		roots = append(roots, resolved)
	}
	dedupeNested := func(rs []string) []string {
		for i := 0; i < len(rs); i++ {
			for j := i + 1; j < len(rs); j++ {
				switch {
				case isSubPath(rs[i], rs[j]):
					// rs[j] contains rs[i]: drop the inner one.
					rs = append(rs[:i], rs[i+1:]...)
					i--
				case isSubPath(rs[j], rs[i]):
					// rs[i] contains rs[j]: drop the inner one.
					rs = append(rs[:j], rs[j+1:]...)
					j--
				}
			}
		}
		return rs
	}
	roots = dedupeNested(roots)
	sort.Slice(roots, func(i, j int) bool { return len(roots[i]) > len(roots[j]) })
	return &CwdPolicy{roots: roots}, nil
}

func dedupeNested(roots []string) {
	for i := 0; i < len(roots); i++ {
		for j := i + 1; j < len(roots); j++ {
			switch {
			case isSubPath(roots[i], roots[j]):
				// roots[j] contains roots[i]: drop the inner one.
				roots = append(roots[:i], roots[i+1:]...)
				i--
			case isSubPath(roots[j], roots[i]):
				// roots[i] contains roots[j]: drop the inner one.
				roots = append(roots[:j], roots[j+1:]...)
				j--
			}
		}
	}
}

func isSubPath(parent, child string) bool {
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

// Roots returns the canonical root list (outermost first).
func (p *CwdPolicy) Roots() []string {
	if p == nil {
		return nil
	}
	return append([]string(nil), p.roots...)
}

// Allows verifies that an existing path, after symlink resolution, lies
// inside one of the allowed roots.
func (p *CwdPolicy) Allows(path string) error {
	if p == nil || len(p.roots) == 0 {
		return fmt.Errorf("%w: no allowed cwd roots configured", ErrCwdNotAuthorized)
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return fmt.Errorf("resolve %s: %w", path, err)
	}
	if !p.contains(resolved) {
		return fmt.Errorf("%w: %s is outside the allowed cwd roots", ErrCwdNotAuthorized, path)
	}
	return nil
}

// AuthorizeProposed authorizes a path that may not exist yet — this is the
// gate that must run BEFORE mkdir/worktree/hook/process side effects. The
// nearest existing ancestor is resolved through symlinks, then the missing
// tail is appended; the combined canonical path must remain inside a root.
// Returns the canonical proposed path.
func (p *CwdPolicy) AuthorizeProposed(path string) (string, error) {
	if p == nil || len(p.roots) == 0 {
		return "", fmt.Errorf("%w: no allowed cwd roots configured", ErrCwdNotAuthorized)
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	// Reject traversal segments up front: a proposed path may not escape via ...
	cleaned := filepath.Clean(abs)

	// Walk up to the nearest existing ancestor, resolving symlinks there.
	tail := []string{}
	current := cleaned
	for {
		if _, err := os.Lstat(current); err == nil {
			break
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", fmt.Errorf("%w: no existing ancestor for %s", ErrCwdNotAuthorized, path)
		}
		tail = append([]string{filepath.Base(current)}, tail...)
		current = parent
	}
	resolvedAncestor, err := filepath.EvalSymlinks(current)
	if err != nil {
		return "", fmt.Errorf("resolve ancestor %s: %w", current, err)
	}
	candidate := resolvedAncestor
	for _, seg := range tail {
		candidate = filepath.Join(candidate, seg)
	}
	if !p.contains(filepath.Clean(candidate)) {
		return "", fmt.Errorf("%w: %s resolves outside the allowed cwd roots", ErrCwdNotAuthorized, path)
	}
	return candidate, nil
}

func (p *CwdPolicy) contains(resolved string) bool {
	for _, root := range p.roots {
		if isSubPath(root, resolved) {
			return true
		}
	}
	return false
}
