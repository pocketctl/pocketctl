package memorysync

import (
	"path"
	"strings"
)

const pocketctlMemoryIgnorePath = ".pocketctlmemoryignore"

// ignoreRules is the committed .pocketctlmemoryignore evaluation state. The
// blob may exclude more than the defaults but can never re-include a
// hard-denied path: hard denial runs before ignore matching.
type ignoreRules struct {
	patterns []ignorePattern
}

type ignorePattern struct {
	raw      string
	dirsOnly bool
}

// parseIgnoreRules accepts one pattern per line: '#' comments, blank lines,
// a trailing '/' for directory prefixes, and '*'/'?' globs relative to the
// repository root. Re-inclusion ('!' prefixes) is deliberately unsupported.
func parseIgnoreRules(content string) (*ignoreRules, error) {
	rules := &ignoreRules{}
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimRight(line, "\r")
		if strings.TrimSpace(trimmed) == "" || strings.HasPrefix(strings.TrimSpace(trimmed), "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "!") {
			// Re-inclusion cannot override the frozen exclusion contract.
			continue
		}
		dirsOnly := strings.HasSuffix(trimmed, "/")
		trimmed = strings.TrimSuffix(trimmed, "/")
		if trimmed == "" {
			continue
		}
		rules.patterns = append(rules.patterns, ignorePattern{raw: trimmed, dirsOnly: dirsOnly})
	}
	return rules, nil
}

// matches reports whether a repository-relative POSIX path is excluded.
func (r *ignoreRules) matches(target string) bool {
	if r == nil {
		return false
	}
	for _, pattern := range r.patterns {
		if matchIgnorePattern(pattern, target) {
			return true
		}
	}
	return false
}

func matchIgnorePattern(pattern ignorePattern, target string) bool {
	if matchGlob(pattern.raw, target) {
		return true
	}
	if pattern.dirsOnly {
		// dir/ excludes everything under the directory tree.
		if strings.HasPrefix(target, pattern.raw+"/") {
			return true
		}
		return matchGlob(pattern.raw, path.Dir(target))
	}
	// A bare name also matches nested paths component-wise, mirroring the
	// usual ignore semantics (e.g. "build" matching "pkg/build").
	for _, segment := range strings.Split(target, "/") {
		if matchGlob(pattern.raw, segment) {
			return true
		}
	}
	return false
}

// matchGlob evaluates '*' and '?' only (no '**'); path elements are matched
// literally otherwise.
func matchGlob(pattern, target string) bool {
	parts := strings.Split(pattern, "/")
	targets := strings.Split(target, "/")
	if len(parts) != len(targets) {
		return false
	}
	for i, part := range parts {
		if !matchSegment(part, targets[i]) {
			return false
		}
	}
	return true
}

func matchSegment(pattern, segment string) bool {
	// Segment-level '*'/'?' matching without treating '/' specially.
	return globMatch(pattern, segment)
}

func globMatch(pattern, s string) bool {
	if pattern == "" {
		return s == ""
	}
	if pattern[0] == '*' {
		for i := 0; i <= len(s); i++ {
			if globMatch(pattern[1:], s[i:]) {
				return true
			}
		}
		return false
	}
	if s == "" {
		return false
	}
	if pattern[0] == '?' || pattern[0] == s[0] {
		return globMatch(pattern[1:], s[1:])
	}
	return false
}
