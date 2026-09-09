package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/mattn/go-isatty"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/i18n"
)

type daemonStatusOptions struct {
	limit int
	pager bool
}

func parseDaemonStatusOptions(args []string, out io.Writer) (daemonStatusOptions, error) {
	options := daemonStatusOptions{limit: 10}
	fs := flag.NewFlagSet("daemon status", flag.ContinueOnError)
	fs.SetOutput(out)
	fs.IntVar(&options.limit, "limit", 10, "Maximum sessions to show (positive integer)")
	all := fs.Bool("all", false, "Print all sessions")
	fs.BoolVar(&options.pager, "pager", false, "Browse all sessions with less (j/k, /search, n, q)")
	if err := fs.Parse(args); err != nil {
		return options, err
	}
	limitSet := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "limit" {
			limitSet = true
		}
	})
	if fs.NArg() != 0 || options.limit <= 0 {
		return options, fmt.Errorf("daemon status: expected --limit N (N > 0), --all, or --pager")
	}
	if (limitSet && (*all || options.pager)) || (*all && options.pager) {
		return options, fmt.Errorf("daemon status: --limit, --all and --pager are mutually exclusive")
	}
	if *all || options.pager {
		options.limit = 0
	}
	return options, nil
}

func sessionStatusActivity(s daemon.SessionState) time.Time {
	if !s.LastActivityAt.IsZero() {
		return s.LastActivityAt
	}
	return s.StartedAt
}

func statusCell(value string, max int) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value)
	runes := []rune(value)
	if len(runes) > max {
		return string(runes[:max-3]) + "..."
	}
	return value
}

func renderDaemonStatusSessions(out io.Writer, sessions []daemon.SessionState, limit int) {
	if len(sessions) == 0 {
		return
	}
	ordered := append([]daemon.SessionState(nil), sessions...)
	sort.SliceStable(ordered, func(i, j int) bool {
		a, b := sessionStatusActivity(ordered[i]), sessionStatusActivity(ordered[j])
		if a.Equal(b) {
			return ordered[i].SessionID < ordered[j].SessionID
		}
		return a.After(b)
	})
	fmt.Fprintln(out, i18n.T("status.sessions", len(ordered)))
	if limit > 0 && len(ordered) > limit {
		ordered = ordered[:limit]
	}
	for _, s := range ordered {
		id := []rune(s.SessionID)
		if len(id) > 8 {
			id = id[:8]
		}
		activity := i18n.T("status.unknown")
		if at := sessionStatusActivity(s); !at.IsZero() {
			activity = at.Local().Format("2006-01-02 15:04")
		}
		fmt.Fprintf(out, "  %-8s  %-12s  %s  %s\n", statusCell(string(id), 8), statusCell(s.Status, 12), activity, statusCell(s.Cwd, 48))
	}
	if len(ordered) < len(sessions) {
		fmt.Fprintln(out, i18n.T("status.sessions_truncated", len(ordered), len(sessions)))
	}
}

func writeDaemonStatusOutput(output string, pager bool) {
	if pager && isatty.IsTerminal(os.Stdout.Fd()) && isatty.IsTerminal(os.Stdin.Fd()) && os.Getenv("TERM") != "dumb" {
		if path, err := exec.LookPath("less"); err == nil {
			cmd := exec.Command(path, "-F", "-S", "-X")
			cmd.Stdin = strings.NewReader(output)
			cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
			if err := cmd.Run(); err == nil {
				return
			}
		}
	}
	fmt.Fprint(os.Stdout, output)
}
