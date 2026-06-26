package ptyscan

import (
	"encoding/json"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// rawMenu mimics the bytes Claude Code's Ink TUI emits when it draws a
// permission/confirmation menu: spinner, ANSI color codes, cursor hide,
// erase-line redraws, and the ❯ selection cursor on the first option.
// Taken from the symptom the user reported (PreToolUse:Bash confirmation).
const rawMenu = "\x1b[?25l\x1b[2K\r" +
	"\x1b[90m●\x1b[0m \x1b[1mHook PreToolUse:Bash requires confirmation for this command:\x1b[0m\n" +
	"\x1b[33m检测到危险操作: git reset --hard 丢弃本地改动。已要求人工确认。\x1b[0m\n" +
	"\x1b[2msettings.json to update hooks\x1b[0m\n\n" +
	"\x1b[1mDo you want to proceed?\x1b[0m\n" +
	"\x1b[36m❯\x1b[0m 1. Yes\n" +
	"  2. No\n" +
	"\x1b[?25h"

func TestFeedDetectsNumberedMenu(t *testing.T) {
	s := NewScanner("sess-1")
	evs := s.Feed([]byte(rawMenu))
	if len(evs) != 1 {
		t.Fatalf("expected 1 event, got %d", len(evs))
	}
	ev := evs[0]
	if ev.Type != "interactive_prompt" {
		t.Fatalf("type = %q, want interactive_prompt", ev.Type)
	}
	if ev.SessionID != "sess-1" {
		t.Errorf("session_id = %q, want sess-1", ev.SessionID)
	}
	if ev.RequestID == "" {
		t.Error("request_id is empty")
	}
	if ev.Input == nil {
		t.Fatal("input payload is nil")
	}

	var p struct {
		Prompt  string   `json:"prompt"`
		Options []Option `json:"options"`
	}
	decodeInput(t, ev, &p)
	if p.Prompt == "" {
		t.Error("prompt text is empty")
	}
	if len(p.Options) != 2 {
		t.Fatalf("options = %d, want 2: %+v", len(p.Options), p.Options)
	}
	if p.Options[0].Index != "1" || p.Options[0].Label != "Yes" {
		t.Errorf("opt0 = {%s,%s}, want {1,Yes}", p.Options[0].Index, p.Options[0].Label)
	}
	if p.Options[1].Index != "2" || p.Options[1].Label != "No" {
		t.Errorf("opt1 = {%s,%s}, want {2,No}", p.Options[1].Index, p.Options[1].Label)
	}

	if got := s.ActiveRequestID(); got != ev.RequestID {
		t.Errorf("ActiveRequestID = %q, want %q", got, ev.RequestID)
	}
}

// TestFeedDedupsRedraws verifies that a TUI redraw of the SAME prompt (the Ink
// loop re-emits the whole menu on every render tick) does not produce a second
// event — the symptom would be a flood of duplicate cards.
func TestFeedDedupsRedraws(t *testing.T) {
	s := NewScanner("sess-1")
	first := s.Feed([]byte(rawMenu))
	if len(first) != 1 {
		t.Fatalf("first feed: expected 1 event, got %d", len(first))
	}
	// Same menu re-rendered by the TUI spinner loop.
	second := s.Feed([]byte(rawMenu))
	if len(second) != 0 {
		t.Fatalf("redraw feed: expected 0 events (dedup), got %d", len(second))
	}
}

// TestResetAllowsFreshPrompt verifies that after the daemon answers a prompt
// (writing the keystroke) and calls Reset, a NEW menu (even with identical text)
// is detected again.
func TestResetAllowsFreshPrompt(t *testing.T) {
	s := NewScanner("sess-1")
	if evs := s.Feed([]byte(rawMenu)); len(evs) != 1 {
		t.Fatalf("first: expected 1, got %d", len(evs))
	}
	s.Reset()
	if rid := s.ActiveRequestID(); rid != "" {
		t.Errorf("after Reset, ActiveRequestID = %q, want empty", rid)
	}
	// A genuinely new prompt re-appears.
	if evs := s.Feed([]byte(rawMenu)); len(evs) != 1 {
		t.Fatalf("after Reset, expected 1 new event, got %d", len(evs))
	}
}

// TestIgnoresPlainTextNumberedList guards the main false-positive risk: an
// agent's prose answer that happens to contain "1. foo 2. bar" without any
// confirmation phrase must NOT become a card.
func TestIgnoresPlainTextNumberedList(t *testing.T) {
	s := NewScanner("sess-1")
	prose := []byte("Here are the steps to reproduce:\n1. Clone the repo\n2. Run the tests\n3. Deploy\n")
	if evs := s.Feed(prose); len(evs) != 0 {
		t.Fatalf("plain prose should not trigger a prompt, got %d events", len(evs))
	}
}

// TestIgnoresQuestionWithoutOptions guards the other half: a confirmation
// phrase with NO numbered options (e.g. a y/n prompt without a rendered list)
// should not raise a card — we can't present options to click.
func TestIgnoresQuestionWithoutOptions(t *testing.T) {
	s := NewScanner("sess-1")
	yn := []byte("Do you want to proceed? (y/n)\n")
	if evs := s.Feed(yn); len(evs) != 0 {
		t.Fatalf("question with no numbered options should not trigger, got %d", len(evs))
	}
}

// TestChinesePhraseDetects verifies the Chinese confirmation phrases from the
// user's actual symptom (检测到危险操作 / 确认) match.
func TestChinesePhraseDetects(t *testing.T) {
	s := NewScanner("sess-1")
	ch := []byte("\x1b[33m检测到危险操作: git reset --hard\x1b[0m\n请选择:\n❯ 1. 继续\n  2. 取消\n")
	evs := s.Feed(ch)
	if len(evs) != 1 {
		t.Fatalf("expected 1 event for Chinese menu, got %d", len(evs))
	}
}

// TestSingleOptionIgnored: a lone "1." with no second option is not a menu.
func TestSingleOptionIgnored(t *testing.T) {
	s := NewScanner("sess-1")
	one := []byte("Do you want to proceed?\n❯ 1. Yes\nsome other text\n")
	if evs := s.Feed(one); len(evs) != 0 {
		t.Fatalf("single option should not trigger, got %d", len(evs))
	}
}

// TestStreamedAcrossFeeds verifies detection works when the menu arrives in
// multiple small PTY read chunks (the realistic case — Read returns partial
// frames). This guards against "only matches if it arrives in one Feed".
func TestStreamedAcrossFeeds(t *testing.T) {
	s := NewScanner("sess-1")
	parts := [][]byte{
		[]byte("Hook PreToolUse:Bash requires confirmation for this command:\n"),
		[]byte("Do you want to proceed?\n"),
		[]byte("❯ 1. Yes\n  2. No\n"),
	}
	for i, p := range parts {
		evs := s.Feed(p)
		want := 0
		if i == len(parts)-1 {
			want = 1
		}
		if len(evs) != want {
			t.Fatalf("chunk %d: got %d events, want %d", i, len(evs), want)
		}
	}
}

// TestThreeOptionMenu verifies the general case (>2 options) the user asked for.
func TestThreeOptionMenu(t *testing.T) {
	s := NewScanner("sess-1")
	m := []byte("Do you want to proceed?\n❯ 1. Yes\n  2. No\n  3. Always\n")
	evs := s.Feed(m)
	if len(evs) != 1 {
		t.Fatalf("expected 1, got %d", len(evs))
	}
	var p struct {
		Options []Option `json:"options"`
	}
	decodeInput(t, evs[0], &p)
	if len(p.Options) != 3 {
		t.Fatalf("options = %d, want 3: %+v", len(p.Options), p.Options)
	}
	if p.Options[2].Label != "Always" {
		t.Errorf("opt2 = %q, want Always", p.Options[2].Label)
	}
}

func decodeInput(t *testing.T, ev protocol.DaemonEvent, v any) {
	t.Helper()
	if err := json.Unmarshal(ev.Input, v); err != nil {
		t.Fatalf("decode input: %v", err)
	}
}
