package adapter

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	CodexUsageLimitExceededCode = "codex_usage_limit_exceeded"
	CodexTurnFailedCode         = "codex_turn_failed"
	CodexTurnFailedMessage      = "Codex turn failed"

	codexErrorMessageMaxBytes      = 4096
	codexUsageLimitFallbackMessage = "Codex usage limit reached. Check Codex usage settings and try again after the limit resets."
)

// CodexProjectedError is the bounded, content-safe subset of a native Codex
// TurnError that PocketCtl may put on its cross-device event stream.
type CodexProjectedError struct {
	Present bool
	Code    string
	Message string
}

type codexNativeError struct {
	Message              string          `json:"message"`
	CodexErrorInfo       json.RawMessage `json:"codexErrorInfo"`
	LegacyCodexErrorInfo json.RawMessage `json:"codex_error_info"`
}

// ProjectCodexError normalizes both app-server and persisted rollout error
// shapes. Only the structured usage-limit category may expose the native
// user-facing message; all other diagnostics fail closed to a generic error.
func ProjectCodexError(raw json.RawMessage) CodexProjectedError {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return CodexProjectedError{}
	}

	projected := CodexProjectedError{
		Present: true,
		Code:    CodexTurnFailedCode,
		Message: CodexTurnFailedMessage,
	}
	var native codexNativeError
	if json.Unmarshal(raw, &native) != nil {
		return projected
	}
	info := native.CodexErrorInfo
	if len(info) == 0 || string(info) == "null" {
		info = native.LegacyCodexErrorInfo
	}
	if codexErrorInfoName(info) != "usagelimitexceeded" {
		return projected
	}

	projected.Code = CodexUsageLimitExceededCode
	projected.Message = sanitizeCodexErrorMessage(native.Message)
	if projected.Message == "" {
		projected.Message = codexUsageLimitFallbackMessage
	}
	return projected
}

func codexErrorInfoName(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var name string
	if json.Unmarshal(raw, &name) != nil {
		return ""
	}
	var normalized strings.Builder
	for _, r := range name {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			normalized.WriteRune(unicode.ToLower(r))
		}
	}
	return normalized.String()
}

func sanitizeCodexErrorMessage(message string) string {
	message = strings.ReplaceAll(message, "\r\n", "\n")
	message = strings.ReplaceAll(message, "\r", "\n")
	message = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) {
			return unicode.ReplacementChar
		}
		return r
	}, message)
	message = strings.TrimSpace(message)
	if len(message) <= codexErrorMessageMaxBytes {
		return message
	}
	const ellipsis = "…"
	end := codexErrorMessageMaxBytes - len(ellipsis)
	for end > 0 && !utf8.ValidString(message[:end]) {
		end--
	}
	return strings.TrimSpace(message[:end]) + ellipsis
}

// CodexErrorEventID is stable across daemon/app-server generations and does
// not expose the native error text or turn identity.
func CodexErrorEventID(logicalTurnID, code, message string) string {
	sum := sha256.Sum256([]byte(logicalTurnID + "\x00" + code + "\x00" + message))
	return "codex:error:" + base64.RawURLEncoding.EncodeToString(sum[:12])
}
