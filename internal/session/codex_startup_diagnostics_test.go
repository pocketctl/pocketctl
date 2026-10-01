package session

import (
	"bytes"
	"log/slog"
	"strings"
	"sync"
	"testing"
)

func captureCodexStartupLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &buf
}

func TestCodexStartupStderrBoundsAndClears(t *testing.T) {
	logs := captureCodexStartupLogs(t)
	s := &codexStartupStderr{}
	input := bytes.Repeat([]byte("x"), 10*codexStartupStderrLimit)
	if n, err := s.Write(input); n != len(input) || err != nil {
		t.Fatalf("write returned %d, %v", n, err)
	}
	if len(s.buf) != codexStartupStderrLimit || cap(s.buf) > codexStartupStderrLimit || !s.truncated {
		t.Fatalf("buffer len=%d cap=%d truncated=%t", len(s.buf), cap(s.buf), s.truncated)
	}
	retained := s.buf
	s.finish("early_exit", 7)
	if !s.stopped || s.buf != nil || !bytes.Equal(retained, make([]byte, len(retained))) {
		t.Fatal("finish did not clear and disable the collector")
	}
	if !strings.Contains(logs.String(), `"stderr_bytes":8192`) || !strings.Contains(logs.String(), `"stderr_truncated":true`) || len(logs.String()) > 512 {
		t.Fatalf("unexpected bounded diagnostic: %s", logs)
	}
	before := logs.String()
	_, _ = s.Write([]byte("actual session content"))
	s.finish("late_failure", 7)
	if s.buf != nil || logs.String() != before {
		t.Fatal("collector retained or logged post-start content")
	}
}

func TestCodexStartupStderrRedactsSplitSecretsAndPaths(t *testing.T) {
	logs := captureCodexStartupLogs(t)
	s := &codexStartupStderr{}
	for _, chunk := range []string{
		`Error: CODEX_`, `HOME points to "/Users/private person/.codex", but that path does not exist` + "\n",
		`Authorization: Bear`, `er arbitrary-private-token` + "\n",
		`{"access_token":"secret`, `-json-value","password":"unknown password"}` + "\n",
		`OPENAI_API_KEY=sk-`, `private-key /home/alice/project ~/secret C:\Users\Alice\auth.json` + "\n",
		"eyJhbGciOiJIUzI1NiJ9.private.jwt\nhttps://name:password@private.host/?token=secret\n",
		"session text and completely unrecognized secret\x1b[31m\n",
	} {
		_, _ = s.Write([]byte(chunk))
	}
	s.finish("early_exit", 2)
	if !strings.Contains(logs.String(), `"diagnosis":"codex_home_missing"`) {
		t.Fatalf("split message lost diagnostic: %s", logs)
	}
	for _, private := range []string{"private person", ".codex", "arbitrary-private-token", "secret-json", "password", "sk-", "alice", "Alice", "eyJ", "private.host", "session text", "unrecognized secret"} {
		if strings.Contains(logs.String(), private) {
			t.Fatalf("private stderr escaped diagnostic: %q", private)
		}
	}
}

func TestCodexStartupStderrConcurrentWritesAndStop(t *testing.T) {
	logs := captureCodexStartupLogs(t)
	s := &codexStartupStderr{}
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			for range 200 {
				_, _ = s.Write([]byte("private chunk"))
			}
		})
	}
	s.finish("", 1)
	wg.Wait()
	if !s.stopped || len(s.buf) != 0 || logs.Len() != 0 {
		t.Fatal("success did not discard concurrent writes without logging")
	}
}

func TestCodexStartupDiagnosisFailsClosed(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"", "stderr_empty"},
		{"unknown /private/path secret=anything", "stderr_redacted"},
		{"Error: Operation not permitted (os error 1)", "permission_denied"},
		{"Permission denied /Users/alice/.codex", "permission_denied"},
		{"Address already in use: /tmp/private.sock", "address_in_use"},
		{"Unix socket path too long /home/private", "socket_path_too_long"},
		{"Error loading config: secret.toml", "config_error"},
		{"unexpected argument --secret", "unsupported_argument"},
		{"CODEX_HOME points to /private", "stderr_redacted"},
	} {
		if got := codexStartupDiagnosis(tc.input); got != tc.want {
			t.Errorf("got %q want %q", got, tc.want)
		}
	}
}
