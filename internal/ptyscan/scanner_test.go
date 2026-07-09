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

// codexTrustMenu mimics Codex 0.143's first-run/untrusted-directory prompt.
// The daemon previously drained this TUI output without surfacing it, so iOS/web
// waited for a rollout JSONL that could never appear until the user chose here.
const codexTrustMenu = "\x1b[>4;0m\x1b[?2026h\x1b[1;1H>\x1b[1;3H\x1b[1mYou are in \x1b[22m/Users/muwenbin\n" +
	"Do you trust the contents of this directory? Working with untrusted contents\n" +
	"comes with higher risk of prompt injection. Trusting the directory allows\n" +
	"project-local config, hooks, and exec policies to load.\n\n" +
	"\x1b[;m› 1. Yes, continue\n" +
	"  2. No, quit\n\n" +
	"\x1b[2mPress enter to continue\x1b[m"

const codexTrustMenuCursorDrawn = "\x1b[?2004h\x1b[>4;0m\x1b[>7u\x1b[?1004h\x1b[6n\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[?u\x1b[c\x1b[?2026h" +
	"\x1b[1;1H\x1b[J\x1b[1;29H\x1b[0m\x1b[m\x1b[K\x1b[2;2H\x1b[0m\x1b[m\x1b[K\x1b[3;79H\x1b[0m\x1b[m\x1b[K" +
	"\x1b[4;76H\x1b[0m\x1b[m\x1b[K\x1b[5;58H\x1b[0m\x1b[m\x1b[K\x1b[6;2H\x1b[0m\x1b[m\x1b[K" +
	"\x1b[7;19H\x1b[0m\x1b[m\x1b[K\x1b[8;14H\x1b[0m\x1b[m\x1b[K\x1b[9;2H\x1b[0m\x1b[m\x1b[K" +
	"\x1b[10;26H\x1b[0m\x1b[m\x1b[K\x1b[1;1H>\x1b[1;3H\x1b[1mYou are in \x1b[22m/Users/muwenbin" +
	"\x1b[3;3HDo\x1b[3;6Hyou\x1b[3;10Htrust\x1b[3;16Hthe\x1b[3;20Hcontents\x1b[3;29Hof\x1b[3;32Hthis\x1b[3;37Hdirectory?" +
	"\x1b[3;48HWorking\x1b[3;56Hwith\x1b[3;61Huntrusted\x1b[3;71Hcontents" +
	"\x1b[4;3Hcomes\x1b[4;9Hwith\x1b[4;14Hhigher\x1b[4;21Hrisk\x1b[4;26Hof\x1b[4;29Hprompt\x1b[4;36Hinjection." +
	"\x1b[4;47HTrusting\x1b[4;56Hthe\x1b[4;60Hdirectory\x1b[4;70Hallows" +
	"\x1b[5;3Hproject-local\x1b[5;17Hconfig,\x1b[5;25Hhooks,\x1b[5;32Hand\x1b[5;36Hexec\x1b[5;41Hpolicies\x1b[5;50Hto\x1b[5;53Hload." +
	"\x1b[7;1H\x1b[;m› 1. Yes, continue\x1b[8;3H\x1b[;m2.\x1b[8;6HNo,\x1b[8;10Hquit\x1b[10;3H\x1b[2mPress enter to continue\x1b[m\x1b[m\x1b[0m\x1b[?25l\x1b[?2026l"

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
	active := s.ActivePrompt()
	if active == nil {
		t.Fatal("ActivePrompt returned nil")
	}
	if active.RequestID != ev.RequestID {
		t.Errorf("ActivePrompt request = %q, want %q", active.RequestID, ev.RequestID)
	}
	active.Options[0].Label = "mutated"
	if again := s.ActivePrompt(); again.Options[0].Label != "Yes" {
		t.Errorf("ActivePrompt should return a copy, got option label %q", again.Options[0].Label)
	}
}

func TestFeedDetectsCodexTrustDirectoryMenu(t *testing.T) {
	s := NewScanner("codex-sess")
	evs := s.Feed([]byte(codexTrustMenu))
	if len(evs) != 1 {
		t.Fatalf("expected 1 event, got %d", len(evs))
	}
	ev := evs[0]
	if ev.Type != "interactive_prompt" {
		t.Fatalf("type = %q, want interactive_prompt", ev.Type)
	}
	if ev.SessionID != "codex-sess" {
		t.Errorf("session_id = %q, want codex-sess", ev.SessionID)
	}

	var p struct {
		Prompt  string   `json:"prompt"`
		Options []Option `json:"options"`
	}
	decodeInput(t, ev, &p)
	if p.Prompt != "Do you trust the contents of this directory?" {
		t.Errorf("prompt = %q", p.Prompt)
	}
	if len(p.Options) != 2 {
		t.Fatalf("options = %d, want 2: %+v", len(p.Options), p.Options)
	}
	if p.Options[0].Index != "1" || p.Options[0].Label != "Yes, continue" {
		t.Errorf("opt0 = {%s,%s}, want {1,Yes, continue}", p.Options[0].Index, p.Options[0].Label)
	}
	if p.Options[1].Index != "2" || p.Options[1].Label != "No, quit" {
		t.Errorf("opt1 = {%s,%s}, want {2,No, quit}", p.Options[1].Index, p.Options[1].Label)
	}
}

func TestFeedDetectsCursorDrawnCodexTrustDirectoryMenu(t *testing.T) {
	s := NewScanner("codex-sess")
	evs := s.Feed([]byte(codexTrustMenuCursorDrawn))
	if len(evs) != 1 {
		t.Fatalf("expected 1 event, got %d", len(evs))
	}
	var p struct {
		Prompt  string   `json:"prompt"`
		Options []Option `json:"options"`
	}
	decodeInput(t, evs[0], &p)
	if p.Prompt != "Do you trust the contents of this directory?" {
		t.Errorf("prompt = %q", p.Prompt)
	}
	if len(p.Options) != 2 {
		t.Fatalf("options = %d, want 2: %+v", len(p.Options), p.Options)
	}
	if p.Options[0].Label != "Yes, continue" || p.Options[1].Label != "No, quit" {
		t.Fatalf("unexpected options: %+v", p.Options)
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
