// Package ptyscan scans the raw stdout of an agent's interactive PTY for
// inline selection menus that the agent's TUI renders to the terminal but never
// writes to its JSONL history.
//
// These menus (e.g. Claude Code's permission prompt "Do you want to proceed?
//   ❯ 1. Yes
//     2. No", or a host PreToolUse hook's confirmation prompt) are pure TUI
// output: they exist only as bytes on the PTY while the agent blocks waiting
// for a keystroke on stdin. Because the daemon's structured output comes from
// the JSONL tailer (not the PTY), such prompts would otherwise be invisible to
// web/iOS clients, leaving the session stuck.
//
// The scanner is deliberately conservative ("better to miss a prompt than to
// raise a false card"). It only fires when it sees BOTH:
//  1. a confirmation/question phrase ("Do you want to proceed?", "requires
//     confirmation", "确认", "是否", …), AND
//  2. at least two numbered options ("1. Yes", "2. No", …) within a few lines
//     after the phrase.
//
// A single prompt is emitted once per occurrence via fingerprint de-duplication,
// so TUI redraws (ANSI cursor resets, spinner re-renders) don't flood clients.
// The daemon writes the user's chosen index back to the PTY stdin and calls
// Reset to clear the active prompt.
package ptyscan

import (
	"encoding/json"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// maxBufBytes caps the rolling window of PTY bytes we inspect. Menus are small
// and short-lived; keeping the tail bounded avoids unbounded growth on a chatty
// TUI and keeps regex scans cheap.
const maxBufBytes = 16 * 1024

// optionScanLines is how many lines after the question phrase we look in for the
// numbered options. Generous enough for a multi-line menu header; tight enough
// to avoid matching an unrelated numbered list elsewhere in the same screen.
const optionScanLines = 8

// minOptions is the minimum number of parsed options for a match to count. A
// real selection menu has ≥2 entries; a lone "1." in prose is ignored.
const minOptions = 2

// promptTimeout is how long a detected prompt stays "active" (and thus
// de-duplicated) before we allow the same fingerprint to match again. Long
// enough to absorb a burst of TUI redraws; short enough that a genuinely new
// prompt with identical text is still surfaced if the first was resolved.
const promptTimeout = 2 * time.Minute

// questionPhrases matches the leading question/confirmation phrase. Compiled
// once. Case-insensitive. Phrases are chosen for high specificity against TUI
// prompts and low false-positive risk against ordinary agent prose.
var questionPhrases = regexp.MustCompile(
	`(?i)` +
		`do you want to (?:proceed|continue)\??` +
		`|proceed\??` +
		`|requires confirmation` +
		`|requires approval` +
		`|needs (?:your )?(?:confirmation|approval)` +
		`|confirm\??` +
		`|(?:请)?(?:确认|是否)` +
		`|是否继续` +
		`|是否(?:允许|同意|执行)` +
		`|(?:等待|需要)你的决定` +
		`|请选择` +
		`|检测到危险操作` +
		`|Do you want to proceed`,
)

// optionLine matches one numbered option row, tolerating the Ink TUI's
// selection cursor "❯" and trailing ANSI. Captures: index, label.
//
//	❯ 1. Yes          → ("1", "Yes")
//	  2) No           → ("2", "No")
//	3. Apply patch    → ("3", "Apply patch")
var optionLine = regexp.MustCompile(`(?:❯|\s)*\s*(\d+)[.)]\s+(\S[^\n\r\x1b]*)`)

// ansiEscape strips CSI/OSC sequences and a few cursor-control bytes the Ink
// TUI emits while redrawing (colors, erase-line "\x1b[2K", hide/show cursor).
// We strip these before matching so redraws collapse to plain text.
var ansiEscape = regexp.MustCompile("\x1b\\[[0-9;?]*[A-Za-z]|\x1b\\][^\x07\x1b]*(?:\x07|\x1b\\\\)|\x1b[=>]|\r")

// stripANSI returns s with ANSI escape / cursor sequences removed and each line
// trimmed (leading/trailing whitespace dropped). Line structure is preserved so
// the caller can reason about option rows; empty lines are kept as separators
// and filtered later by splitNonEmpty.
func stripANSI(s string) string {
	s = ansiEscape.ReplaceAllString(s, "")
	var b strings.Builder
	b.Grow(len(s))
	for i, ln := range strings.Split(s, "\n") {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(strings.TrimSpace(ln))
	}
	return b.String()
}

// Option is one selectable entry parsed from the menu.
type Option struct {
	Index string `json:"index"` // the on-screen index, e.g. "1"
	Label string `json:"label"` // the option text, e.g. "Yes"
}

// PendingPrompt is a detected-but-not-yet-answered selection menu.
type PendingPrompt struct {
	RequestID  string   `json:"request_id"`
	PromptText string   `json:"prompt"`
	Options    []Option `json:"options"`
}

// Scanner inspects a rolling window of PTY bytes for selection menus. It is
// safe for concurrent use by a single Feeding goroutine and a Resolving
// goroutine (the daemon writes the answer from a different goroutine).
type Scanner struct {
	sessionID string

	mu     sync.Mutex
	buf    []byte
	active *PendingPrompt // non-nil between detection and Reset/timeout

	// seenFingerprints dedupes prompts: fingerprint → last seen time. Prevents
	// TUI redraws of the same prompt from raising multiple cards.
	seen map[string]time.Time
}

// NewScanner creates a scanner bound to a session id (stamped on emitted events).
func NewScanner(sessionID string) *Scanner {
	return &Scanner{sessionID: sessionID, seen: make(map[string]time.Time)}
}

// Feed appends PTY bytes and returns any newly-detected interactive_prompt
// events. At most one event is returned per Feed call (the first new prompt
// found); subsequent redraws of the same prompt are suppressed until the
// timeout elapses or Reset is called.
func (s *Scanner) Feed(data []byte) []protocol.DaemonEvent {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Append and bound the window. We keep the tail; menus appear at the bottom
	// of the stream right when the agent blocks.
	s.buf = append(s.buf, data...)
	if len(s.buf) > maxBufBytes {
		s.buf = s.buf[len(s.buf)-maxBufBytes:]
	}

	// Prune expired fingerprints occasionally so the map doesn't grow forever.
	now := time.Now()
	for fp, t := range s.seen {
		if now.Sub(t) > promptTimeout {
			delete(s.seen, fp)
		}
	}

	prompt := s.detectLocked()
	if prompt == nil {
		return nil
	}
	s.active = prompt
	s.seen[s.fingerprint(prompt)] = now

	input, _ := json.Marshal(map[string]any{
		"prompt":  prompt.PromptText,
		"options": prompt.Options,
	})
	return []protocol.DaemonEvent{{
		Type:      "interactive_prompt",
		SessionID: s.sessionID,
		RequestID: prompt.RequestID,
		Input:     input,
	}}
}

// detectLocked scans the current buffer for a menu, returning a PendingPrompt
// (with a fresh request id) or nil. Caller must hold s.mu.
func (s *Scanner) detectLocked() *PendingPrompt {
	clean := stripANSI(string(s.buf))
	if clean == "" {
		return nil
	}

	// Find the LAST question phrase in the window — the relevant prompt is the
	// one currently blocking, which is the most recently drawn one.
	phraseLoc := questionPhrases.FindStringIndex(clean)
	if phraseLoc == nil {
		return nil
	}
	promptText := strings.TrimSpace(clean[phraseLoc[0]:phraseLoc[1]])

	// Search forward from the phrase for numbered options.
	tail := clean[phraseLoc[1]:]
	tailLines := splitNonEmpty(tail)
	if len(tailLines) > optionScanLines {
		tailLines = tailLines[:optionScanLines]
	}

	var opts []Option
	// Stop scanning further lines once we've seen the menu and hit a blank or
	// non-option line after collecting ≥2 options — this delimits the menu from
	// unrelated text below it. While still inside the numbered list, keep
	// collecting so multi-row menus (3+ options, one per line) are captured.
	menuStarted := false
	for _, ln := range tailLines {
		matches := optionLine.FindAllStringSubmatch(ln, -1)
		if len(matches) == 0 {
			if menuStarted && len(opts) >= minOptions {
				break // blank line ends the menu
			}
			continue
		}
		menuStarted = true
		for _, m := range matches {
			idx := strings.TrimSpace(m[1])
			label := strings.TrimSpace(m[2])
			if idx == "" || label == "" {
				continue
			}
			opts = append(opts, Option{Index: idx, Label: label})
		}
	}

	if len(opts) < minOptions {
		return nil
	}

	// De-dup: if this exact prompt was seen recently, suppress.
	fp := fingerprintOf(promptText, opts)
	if _, seen := s.seen[fp]; seen {
		return nil
	}

	return &PendingPrompt{
		RequestID:  uuid.New().String(),
		PromptText: promptText,
		Options:    dedupOptions(opts),
	}
}

// ActiveRequestID returns the request id of the currently pending prompt, or ""
// if none. Used by the daemon to validate an incoming response.
func (s *Scanner) ActiveRequestID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active == nil {
		return ""
	}
	return s.active.RequestID
}

// Reset clears the active prompt so the next Feed can detect a fresh menu. Called
// by the daemon after writing the user's choice to the PTY.
func (s *Scanner) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active = nil
	// Trim the buffer to drop the already-rendered menu so a redraw right after
	// answering doesn't re-detect the stale prompt.
	if len(s.buf) > 0 {
		s.buf = s.buf[len(s.buf)/2:]
	}
}

// fingerprint returns a stable key for a detected prompt (phrase + options).
// Two prompts with the same text and the same options share a fingerprint and
// are de-duplicated within promptTimeout.
func (s *Scanner) fingerprint(p *PendingPrompt) string {
	return fingerprintOf(p.PromptText, p.Options)
}

func fingerprintOf(promptText string, opts []Option) string {
	var b strings.Builder
	b.WriteString(promptText)
	b.WriteByte('|')
	for _, o := range opts {
		b.WriteString(o.Index)
		b.WriteByte(':')
		b.WriteString(o.Label)
		b.WriteByte(';')
	}
	return b.String()
}

// dedupOptions drops duplicate index/label pairs (TUI redraws can repeat rows).
func dedupOptions(opts []Option) []Option {
	seen := make(map[string]bool, len(opts))
	out := opts[:0]
	for _, o := range opts {
		k := o.Index + ":" + o.Label
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, o)
	}
	return out
}

// splitNonEmpty returns tail split on newlines with empty lines removed.
func splitNonEmpty(s string) []string {
	var out []string
	for _, ln := range strings.Split(s, "\n") {
		if strings.TrimSpace(ln) != "" {
			out = append(out, ln)
		}
	}
	return out
}
