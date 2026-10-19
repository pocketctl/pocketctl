package update

import (
	"regexp"
	"strings"
)

var releaseVersion = regexp.MustCompile(`^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$`)

func parseVersion(v string) []string {
	parts := releaseVersion.FindStringSubmatch(v)
	if parts == nil {
		return nil
	}
	for _, id := range strings.Split(parts[4], ".") {
		if numericID(id) && len(id) > 1 && id[0] == '0' {
			return nil
		}
	}
	return parts
}
func numericID(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
func compareNumber(a, b string) int {
	if len(a) < len(b) {
		return -1
	}
	if len(a) > len(b) {
		return 1
	}
	return strings.Compare(a, b)
}

// IsNewerVersion compares complete semantic versions. Unknown/development
// versions are not actionable; build metadata does not affect precedence.
func IsNewerVersion(current, target string) bool {
	a, b := parseVersion(current), parseVersion(target)
	if a == nil || b == nil {
		return false
	}
	for i := 1; i <= 3; i++ {
		if c := compareNumber(b[i], a[i]); c != 0 {
			return c > 0
		}
	}
	if a[4] == b[4] {
		return false
	}
	if b[4] == "" {
		return true
	}
	if a[4] == "" {
		return false
	}
	ap, bp := strings.Split(a[4], "."), strings.Split(b[4], ".")
	for i := 0; i < len(ap) && i < len(bp); i++ {
		x, y := bp[i], ap[i]
		var c int
		switch {
		case numericID(x) && numericID(y):
			c = compareNumber(x, y)
		case numericID(x):
			c = -1
		case numericID(y):
			c = 1
		default:
			c = strings.Compare(x, y)
		}
		if c != 0 {
			return c > 0
		}
	}
	return len(bp) > len(ap)
}
