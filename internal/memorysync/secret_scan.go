package memorysync

import (
	"path"
	"regexp"
	"strings"
)

// Content-level defense in depth (ADR-0006 §2): a bounded scanner rejects
// private-key blocks and known credential/token formats before hashing or
// upload. It records only a reason code, never the match.
var secretPatterns = []struct {
	reason  string
	pattern *regexp.Regexp
}{
	{"secret_content", regexp.MustCompile(`-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |)PRIVATE KEY-----`)},
	{"secret_content", regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`)},
	{"secret_content", regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{20,}\b`)},
	{"secret_content", regexp.MustCompile(`\bxox[baprs]-[A-Za-z0-9-]{10,}\b`)},
	{"secret_content", regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{35}\b`)},
	{"secret_content", regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{20,}\b`)},
}

// scanSecrets reports whether content carries a bounded known secret shape.
func scanSecrets(content string) (reason string, found bool) {
	// Bound the scanned window: secrets near file starts are the realistic
	// regression, and scanning stays linear in file size overall.
	if len(content) > 1<<20 {
		content = content[:1<<20]
	}
	for _, entry := range secretPatterns {
		if entry.pattern.MatchString(content) {
			return entry.reason, true
		}
	}
	return "", false
}

// hardDenyPathClasses are path shapes that can never be re-included.
var hardDeniedExact = map[string]bool{
	".env": true, "id_rsa": true, "id_ed25519": true,
	"credentials.json": true, "secrets.yaml": true, "secrets.yml": true,
}

var hardDeniedPrefixes = []string{
	".git/",
	"node_modules/",
	"vendor/",
	"dist/",
	"build/",
	"out/",
	"coverage/",
	".next/",
	"target/",
	"__pycache__/",
	".venv/",
	"venv/",
}

var hardDeniedFileSuffixes = []string{
	".env", ".pem", ".key", ".p12", ".pfx", ".jks", ".kdbx",
}

var hardDeniedNamePrefixes = []string{
	".env.", "id_rsa", "id_ed25519",
}

var generatedOrMinifiedSuffixes = []string{
	".min.js", ".min.css", ".map",
}

var generatedDeclarationSuffix = ".d.ts"

var lockfileNames = map[string]bool{
	"package-lock.json": true, "yarn.lock": true, "pnpm-lock.yaml": true,
	"poetry.lock": true, "Cargo.lock": true, "composer.lock": true,
}

// hardDenyReason returns the bounded exclusion code for a path, if any.
func hardDenyReason(target string) (string, bool) {
	if lockfileNames[path.Base(target)] {
		return "lockfile", true
	}
	segments := strings.Split(target, "/")
	for _, segment := range segments[:len(segments)-1] {
		for _, prefix := range hardDeniedPrefixes {
			if segment == strings.TrimSuffix(prefix, "/") {
				return "hard_denied_path", true
			}
		}
	}
	base := path.Base(target)
	if hardDeniedExact[base] || strings.HasPrefix(base, ".env.") {
		return "hard_denied_path", true
	}
	for _, prefix := range hardDeniedNamePrefixes {
		if strings.HasPrefix(base, prefix) {
			return "hard_denied_path", true
		}
	}
	for _, suffix := range hardDeniedFileSuffixes {
		if strings.HasSuffix(base, suffix) {
			return "hard_denied_path", true
		}
	}
	for _, suffix := range generatedOrMinifiedSuffixes {
		if strings.HasSuffix(base, suffix) {
			return "generated_or_minified", true
		}
	}
	if strings.HasSuffix(base, generatedDeclarationSuffix) {
		return "generated_declaration", true
	}
	return "", false
}
