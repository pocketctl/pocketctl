package main

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/daemon"
)

func TestDaemonStatusOptions(t *testing.T) {
	for _, tc := range []struct {
		args           []string
		limit          int
		pager, invalid bool
	}{
		{nil, 10, false, false},
		{[]string{"--limit", "30"}, 30, false, false},
		{[]string{"--all"}, 0, false, false},
		{[]string{"--pager"}, 0, true, false},
		{[]string{"--limit", "0"}, 0, false, true},
		{[]string{"--limit", "-1"}, 0, false, true},
		{[]string{"--all", "--limit", "10"}, 0, false, true},
		{[]string{"--pager", "--all"}, 0, false, true},
		{[]string{"unexpected"}, 0, false, true},
	} {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			got, err := parseDaemonStatusOptions(tc.args, io.Discard)
			if (err != nil) != tc.invalid {
				t.Fatalf("error = %v", err)
			}
			if !tc.invalid && (got.limit != tc.limit || got.pager != tc.pager) {
				t.Fatalf("options = %+v", got)
			}
		})
	}
}

func TestDaemonStatusSessionsRecentLimit(t *testing.T) {
	base := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	var sessions []daemon.SessionState
	for i := 0; i < 12; i++ {
		sessions = append(sessions, daemon.SessionState{SessionID: fmt.Sprintf("s%02d", i), Cwd: fmt.Sprintf("/project-%02d", i), LastActivityAt: base.Add(time.Duration(i) * time.Minute)})
	}
	// Start time is the fallback when no activity has been recorded.
	sessions[11].StartedAt, sessions[11].LastActivityAt = base.Add(time.Hour), time.Time{}
	var out bytes.Buffer
	renderDaemonStatusSessions(&out, sessions, 10)
	got := out.String()
	if strings.Contains(got, "/project-00") || strings.Contains(got, "/project-01") || strings.Count(got, "/project-") != 10 {
		t.Fatalf("wrong visible sessions: %s", got)
	}
	if strings.Index(got, "/project-11") > strings.Index(got, "/project-10") || !strings.Contains(got, "--pager") {
		t.Fatalf("wrong order or missing hint: %s", got)
	}
	if sessions[0].SessionID != "s00" {
		t.Fatal("mutated source order")
	}
	out.Reset()
	renderDaemonStatusSessions(&out, sessions, 0)
	if strings.Count(out.String(), "/project-") != 12 || strings.Contains(out.String(), "--pager") {
		t.Fatalf("all sessions: %s", out.String())
	}
}

func TestDaemonStatusCellSingleLine(t *testing.T) {
	if got := statusCell("path\n\t\x1bname", 48); strings.ContainsAny(got, "\n\t\x1b") {
		t.Fatalf("control characters: %q", got)
	}
	if got := statusCell(strings.Repeat("x", 60), 48); len(got) != 48 || !strings.HasSuffix(got, "...") {
		t.Fatalf("truncation: %q", got)
	}
}
