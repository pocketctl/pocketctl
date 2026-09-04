package memorycontext

import (
	"regexp"
	"strings"
)

// Query minimization (plan 7.1/12.1): the daemon sends Memory ONLY a
// retrieval-only copy of the task text — secrets and high-entropy tokens
// redacted, the PocketCtl context envelope marker stripped, capped at
// 32 KiB. The original user input is never replaced by this copy.

const MaxQueryBytes = 32 * 1024

const envelopeMarker = "<pocketctl_memory_context"

var (
	secretPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)(api[_-]?key|token|secret|password|authorization|bearer)[=: ]+\S+`),
		regexp.MustCompile(`[A-Za-z0-9+/]{40,}={0,2}`),
		regexp.MustCompile(`[0-9a-fA-F]{32,}`),
		regexp.MustCompile(`-----BEGIN [A-Z ]+-----`),
	}
)

// SanitizeQuery builds the transient retrieval copy. When minimization
// leaves no useful text the caller skips dynamic retrieval entirely — the
// boolean reports exactly that.
func SanitizeQuery(raw string) (string, bool) {
	text := raw
	// Strip any injected PocketCtl context envelope before it can loop.
	if idx := strings.Index(text, envelopeMarker); idx >= 0 {
		text = text[:idx]
	}
	for _, pattern := range secretPatterns {
		text = pattern.ReplaceAllString(text, "[redacted]")
	}
	text = strings.TrimSpace(text)
	if len(text) > MaxQueryBytes {
		text = text[:MaxQueryBytes]
	}
	// At least one letters run of 4+ characters (Latin or CJK) is "useful".
	useful := regexp.MustCompile(`[A-Za-z\p{Han}]{4,}`).MatchString(text)
	return text, useful
}
