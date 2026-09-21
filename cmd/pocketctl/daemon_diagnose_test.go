package main

import (
	"bytes"
	"errors"
	"flag"
	"io"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/i18n"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
)

func TestDaemonDiagnoseArgs(t *testing.T) {
	for _, tc := range []struct {
		name    string
		args    []string
		want    string
		wantErr bool
	}{
		{name: "session", args: []string{"thr_123"}, want: "thr_123"},
		{name: "trim", args: []string{"  ses_123  "}, want: "ses_123"},
		{name: "missing", wantErr: true},
		{name: "too many", args: []string{"one", "two"}, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseDaemonDiagnoseArgs(tc.args, io.Discard)
			if (err != nil) != tc.wantErr || got != tc.want {
				t.Fatalf("parse = %q, %v", got, err)
			}
		})
	}
}

func TestDaemonDiagnoseHelpDescribesCommand(t *testing.T) {
	i18n.Set(i18n.English)
	t.Cleanup(func() { i18n.Set(i18n.English) })
	var out bytes.Buffer
	_, err := parseDaemonDiagnoseArgs([]string{"--help"}, &out)
	if !errors.Is(err, flag.ErrHelp) {
		t.Fatalf("error = %v, want flag.ErrHelp", err)
	}
	for _, want := range []string{
		"Diagnose whether a session is proxied",
		"pocketctl daemon diagnose <session-id>",
		"pocketctl daemon status --all",
	} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("help missing %q:\n%s", want, out.String())
		}
	}
}

func TestDiagnoseSessionClassifications(t *testing.T) {
	i18n.Set(i18n.English)
	t.Cleanup(func() { i18n.Set(i18n.English) })
	for _, tc := range []struct {
		name       string
		session    daemon.SessionState
		wantProxy  sessionProxyState
		wantReason string
		wantFix    string
	}{
		{
			name: "managed codex", session: daemon.SessionState{
				SessionID: "managed", Agent: adapter.AgentCodex, Source: "terminal", ControlMode: protocol.ControlManaged,
			}, wantProxy: sessionProxyYes, wantReason: "diagnose.reason_managed",
		},
		{
			name: "claude terminal", session: daemon.SessionState{
				SessionID: "claude", Agent: adapter.AgentClaude, Source: "terminal",
			}, wantProxy: sessionProxyYes, wantReason: "diagnose.reason_claude",
		},
		{
			name: "unmanaged opencode", session: daemon.SessionState{
				SessionID: "unmanaged", Agent: adapter.AgentOpencode, Source: "terminal", ControlMode: protocol.ControlUnmanagedActive,
			}, wantProxy: sessionProxyNo, wantReason: "diagnose.reason_unmanaged_active", wantFix: "opencode -s unmanaged",
		},
		{
			name: "codex desktop", session: daemon.SessionState{
				SessionID: "desktop", Agent: adapter.AgentCodexDesktop, Source: "observer", ControlMode: protocol.ControlLegacyReadOnly,
			}, wantProxy: sessionProxyNo, wantReason: "diagnose.reason_codex_desktop", wantFix: "cannot accept remote input",
		},
		{
			name: "old metadata", session: daemon.SessionState{
				SessionID: "old", Agent: adapter.AgentCodex,
			}, wantProxy: sessionProxyUnknown, wantReason: "diagnose.reason_metadata", wantFix: "Restart the daemon",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := daemon.DaemonState{Connected: true, Sessions: []daemon.SessionState{tc.session}}
			got := diagnoseSession(state, tc.session.SessionID)
			if !got.found || got.proxy != tc.wantProxy || got.reasonKey != tc.wantReason {
				t.Fatalf("diagnosis = %+v", got)
			}
			if tc.wantFix != "" && (len(got.suggestions) == 0 || !strings.Contains(got.suggestions[0], tc.wantFix)) {
				t.Fatalf("suggestions = %q, want %q", got.suggestions, tc.wantFix)
			}
		})
	}
}

func TestDiagnoseSessionNotFoundAndDisconnected(t *testing.T) {
	i18n.Set(i18n.English)
	t.Cleanup(func() { i18n.Set(i18n.English) })
	notFound := diagnoseSession(daemon.DaemonState{Connected: true}, "missing")
	if notFound.found || notFound.proxy != sessionProxyNo || notFound.reasonKey != "diagnose.reason_not_found" {
		t.Fatalf("not found = %+v", notFound)
	}

	disconnected := diagnoseSession(daemon.DaemonState{
		Connected: false,
		Sessions: []daemon.SessionState{{
			SessionID: "managed", Agent: adapter.AgentCodex, ControlMode: protocol.ControlManaged,
		}},
	}, "managed")
	if disconnected.proxy != sessionProxyYes || len(disconnected.suggestions) != 1 ||
		!strings.Contains(disconnected.suggestions[0], "daemon connection") {
		t.Fatalf("disconnected = %+v", disconnected)
	}
}

func TestRenderSessionDiagnosisIncludesActionableResult(t *testing.T) {
	i18n.Set(i18n.English)
	t.Cleanup(func() { i18n.Set(i18n.English) })
	state := daemon.DaemonState{
		PID: 10, Connected: true,
		Sessions: []daemon.SessionState{{
			SessionID: "ses_1", Agent: adapter.AgentOpencode, Status: protocol.StatusIdle,
			Source: "terminal", ControlMode: protocol.ControlUnmanagedActive,
		}},
	}
	var out bytes.Buffer
	renderSessionDiagnosis(&out, state, diagnoseSession(state, "ses_1"))
	got := out.String()
	for _, want := range []string{"Session diagnosis", "Session: ses_1", "Proxied: no", "Suggested fix:", "opencode -s ses_1"} {
		if !strings.Contains(got, want) {
			t.Fatalf("output missing %q:\n%s", want, got)
		}
	}
}

func TestDaemonSessionStatesPreservesDiagnosisMetadata(t *testing.T) {
	capabilities := []string{"message_acceptance_receipt"}
	states := daemonSessionStates([]session.SessionInfo{{
		SessionID: "thr_1", Agent: adapter.AgentCodex, Source: "terminal",
		ControlMode: protocol.ControlManaged, Capabilities: capabilities,
	}})
	if len(states) != 1 || states[0].Source != "terminal" ||
		states[0].ControlMode != protocol.ControlManaged || len(states[0].Capabilities) != 1 {
		t.Fatalf("state = %+v", states)
	}
	capabilities[0] = "mutated"
	if states[0].Capabilities[0] != "message_acceptance_receipt" {
		t.Fatalf("capabilities were not copied: %+v", states[0].Capabilities)
	}
}
