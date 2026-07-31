// Package i18n provides lightweight bilingual (English / Chinese) message
// lookup for the pocketctl CLI.
//
// The display language is detected once at package init from the LC_ALL /
// LC_MESSAGES / LANG environment variables (POSIX precedence) and cached in a
// package-level variable. A locale containing "zh" (zh_CN, zh_TW, zh_HK,
// zh_Hans, …) resolves to Chinese; everything else defaults to English.
//
// T returns the localized message for a key, substituting any trailing args
// into the message template. Unknown keys are treated as a literal template so
// that partially-migrated call sites keep working instead of panicking.
package i18n

import (
	"fmt"
	"os"
	"strings"
)

// Lang is the resolved display language.
type Lang int

const (
	English Lang = iota
	Chinese
)

// current is resolved once at package init. CLI processes are short-lived, so
// runtime locale switching is not supported.
var current = detect()

// detect returns Chinese if the first non-empty locale variable (LC_ALL >
// LC_MESSAGES > LANG) contains "zh"; otherwise English.
func detect() Lang {
	for _, key := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if v := os.Getenv(key); v != "" {
			if strings.Contains(strings.ToLower(v), "zh") {
				return Chinese
			}
			// POSIX precedence: the first non-empty variable wins. If a non-zh
			// locale is explicitly set, honour it instead of falling through.
			return English
		}
	}
	return English
}

// Current returns the resolved display language (English by default).
func Current() Lang { return current }

// CurrentCode returns the resolved display language as an API language code.
func CurrentCode() string {
	if Current() == Chinese {
		return "zh"
	}
	return "en"
}

// Set overrides the detected language. Intended for tests; callers normally
// rely on auto-detection.
func Set(l Lang) { current = l }

// T returns the localized message for the given key, substituting any
// trailing args into the message template for the current language. The first
// arg is the message key (a string); the remaining args fill the template's
// placeholders. If the key is unknown, the key itself is used as the template
// — this keeps incremental migration safe (an unmigrated call site prints its
// key rather than panicking, and missing keys are immediately visible).
//
// The variadic-any signature (rather than key string + ...any) is deliberate:
// it keeps `go vet`'s printf checker from misclassifying T as a printf-like
// function and flagging every call site.
func T(args ...any) string {
	if len(args) == 0 {
		return ""
	}
	key, ok := args[0].(string)
	if !ok {
		return fmt.Sprint(args...)
	}
	rest := args[1:]
	entry, found := messages[key]
	if !found {
		if len(rest) == 0 {
			return key
		}
		return fmt.Sprintf(key, rest...)
	}
	tmpl := entry.template(current)
	if len(rest) == 0 {
		return tmpl
	}
	return fmt.Sprintf(tmpl, rest...)
}
