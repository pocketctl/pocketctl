package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/i18n"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

type sessionProxyState uint8

const (
	sessionProxyUnknown sessionProxyState = iota
	sessionProxyNo
	sessionProxyYes
)

type sessionDiagnosis struct {
	sessionID   string
	agent       string
	status      string
	proxy       sessionProxyState
	reasonKey   string
	suggestions []string
	found       bool
}

func parseDaemonDiagnoseArgs(args []string, out io.Writer) (string, error) {
	fs := flag.NewFlagSet("daemon diagnose", flag.ContinueOnError)
	fs.SetOutput(out)
	fs.Usage = func() { fmt.Fprintln(out, i18n.T("diagnose.help")) }
	if err := fs.Parse(args); err != nil {
		return "", err
	}
	if fs.NArg() != 1 || strings.TrimSpace(fs.Arg(0)) == "" {
		return "", errors.New(i18n.T("diagnose.usage"))
	}
	return strings.TrimSpace(fs.Arg(0)), nil
}

func diagnoseSession(state daemon.DaemonState, sessionID string) sessionDiagnosis {
	diagnosis := sessionDiagnosis{
		sessionID: sessionID,
		proxy:     sessionProxyNo,
		reasonKey: "diagnose.reason_not_found",
		suggestions: []string{
			i18n.T("diagnose.fix_not_found"),
		},
	}
	var current *daemon.SessionState
	for i := range state.Sessions {
		if state.Sessions[i].SessionID == sessionID {
			current = &state.Sessions[i]
			break
		}
	}
	if current == nil {
		return diagnosis
	}

	diagnosis.found = true
	diagnosis.agent = current.Agent
	diagnosis.status = current.Status
	diagnosis.suggestions = nil

	switch {
	case current.ControlMode == protocol.ControlManaged:
		diagnosis.proxy = sessionProxyYes
		diagnosis.reasonKey = "diagnose.reason_managed"
	case current.Agent == adapter.AgentClaude && (current.Source == "terminal" || current.Source == "daemon"):
		diagnosis.proxy = sessionProxyYes
		diagnosis.reasonKey = "diagnose.reason_claude"
	case current.Agent == adapter.AgentCodexDesktop:
		diagnosis.proxy = sessionProxyNo
		diagnosis.reasonKey = "diagnose.reason_codex_desktop"
		diagnosis.suggestions = []string{i18n.T("diagnose.fix_observer")}
	case current.Agent == adapter.AgentZcode && current.Source == "observer":
		diagnosis.proxy = sessionProxyNo
		diagnosis.reasonKey = "diagnose.reason_zcode_observer"
		diagnosis.suggestions = []string{i18n.T("diagnose.fix_observer")}
	case current.ControlMode == protocol.ControlUnmanagedActive:
		diagnosis.proxy = sessionProxyNo
		diagnosis.reasonKey = "diagnose.reason_unmanaged_active"
		diagnosis.suggestions = agentProxySuggestions(current.Agent, sessionID)
	case current.ControlMode == protocol.ControlLegacyReadOnly || current.Source == "observer":
		diagnosis.proxy = sessionProxyNo
		diagnosis.reasonKey = "diagnose.reason_read_only"
		diagnosis.suggestions = agentProxySuggestions(current.Agent, sessionID)
	default:
		diagnosis.proxy = sessionProxyUnknown
		diagnosis.reasonKey = "diagnose.reason_metadata"
		diagnosis.suggestions = []string{i18n.T("diagnose.fix_restart")}
	}

	if !state.Connected {
		diagnosis.suggestions = append([]string{i18n.T("diagnose.fix_relay")}, diagnosis.suggestions...)
	}
	return diagnosis
}

func agentProxySuggestions(agent, sessionID string) []string {
	switch agent {
	case adapter.AgentOpencode:
		return []string{i18n.T("diagnose.fix_opencode", sessionID)}
	case adapter.AgentCodex:
		return []string{i18n.T("diagnose.fix_codex", sessionID)}
	case adapter.AgentClaude:
		return []string{i18n.T("diagnose.fix_claude")}
	case adapter.AgentCodexDesktop, adapter.AgentZcode:
		return []string{i18n.T("diagnose.fix_observer")}
	default:
		return []string{i18n.T("diagnose.fix_not_found")}
	}
}

func renderSessionDiagnosis(out io.Writer, state daemon.DaemonState, diagnosis sessionDiagnosis) {
	fmt.Fprintln(out, i18n.T("diagnose.title"))
	fmt.Fprintln(out, i18n.T("diagnose.session", diagnosis.sessionID))
	if diagnosis.found {
		fmt.Fprintln(out, i18n.T("diagnose.agent", diagnosis.agent))
		fmt.Fprintln(out, i18n.T("diagnose.status", diagnosis.status))
	}
	proxy := i18n.T("diagnose.unknown")
	switch diagnosis.proxy {
	case sessionProxyYes:
		proxy = i18n.T("diagnose.yes")
	case sessionProxyNo:
		proxy = i18n.T("diagnose.no")
	}
	fmt.Fprintln(out, i18n.T("diagnose.proxy", proxy))
	if state.PID > 0 {
		relay := i18n.T("diagnose.relay_disconnected")
		if state.Connected {
			relay = i18n.T("diagnose.relay_connected")
		}
		fmt.Fprintln(out, i18n.T("diagnose.relay", relay))
	}
	fmt.Fprintln(out, i18n.T("diagnose.reason", i18n.T(diagnosis.reasonKey)))
	if len(diagnosis.suggestions) == 0 {
		return
	}
	fmt.Fprintln(out, i18n.T("diagnose.suggestion"))
	for _, suggestion := range diagnosis.suggestions {
		fmt.Fprintln(out, "  - "+suggestion)
	}
}

func renderUnavailableSessionDiagnosis(out io.Writer, sessionID, reasonKey string, reasonArgs ...any) {
	suggestionKey := "diagnose.fix_restart"
	if reasonKey == "diagnose.reason_not_running" {
		suggestionKey = "diagnose.fix_start"
	}
	diagnosis := sessionDiagnosis{
		sessionID: sessionID,
		proxy:     sessionProxyUnknown,
		reasonKey: reasonKey,
		suggestions: []string{
			i18n.T(suggestionKey),
		},
	}
	fmt.Fprintln(out, i18n.T("diagnose.title"))
	fmt.Fprintln(out, i18n.T("diagnose.session", diagnosis.sessionID))
	fmt.Fprintln(out, i18n.T("diagnose.proxy", i18n.T("diagnose.unknown")))
	reasonParams := append([]any{reasonKey}, reasonArgs...)
	fmt.Fprintln(out, i18n.T("diagnose.reason", i18n.T(reasonParams...)))
	fmt.Fprintln(out, i18n.T("diagnose.suggestion"))
	for _, suggestion := range diagnosis.suggestions {
		fmt.Fprintln(out, "  - "+suggestion)
	}
}

func cmdDaemonDiagnose(args []string) {
	sessionID, err := parseDaemonDiagnoseArgs(args, os.Stderr)
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	pid, running, runtimeErr := daemon.RuntimeStatus()
	if runtimeErr != nil {
		renderUnavailableSessionDiagnosis(os.Stdout, sessionID, "diagnose.reason_state_uncertain", runtimeErr)
		return
	}
	if !running {
		renderUnavailableSessionDiagnosis(os.Stdout, sessionID, "diagnose.reason_not_running")
		return
	}
	state, err := daemon.ReadState()
	if err != nil {
		renderUnavailableSessionDiagnosis(os.Stdout, sessionID, "diagnose.reason_state_unavailable", err)
		return
	}
	verified, verifyErr := daemon.VerifyRuntimeIdentity(state.PID, state.RuntimeInstanceToken)
	if verifyErr != nil || !verified || state.PID != pid {
		if verifyErr == nil && !verified {
			verifyErr = errors.New("daemon process identity does not match the state snapshot")
		} else if verifyErr == nil {
			verifyErr = fmt.Errorf("state PID %d does not match runtime PID %d", state.PID, pid)
		}
		renderUnavailableSessionDiagnosis(os.Stdout, sessionID, "diagnose.reason_state_uncertain", verifyErr)
		return
	}
	renderSessionDiagnosis(os.Stdout, *state, diagnoseSession(*state, sessionID))
}
