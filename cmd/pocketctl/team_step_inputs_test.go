package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/memorycontext"
	"github.com/pocketctl/pocketctl/internal/memorymcp"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/ws"
)

func TestStepInputDownloadDoesNotBlockCommandControlReplies(t *testing.T) {
	for _, control := range []string{"session_interrupt", "session_kill"} {
		t.Run(control, func(t *testing.T) { testStepInputControl(t, control) })
	}
}

func TestStepInputCapabilityOptInIsStrict(t *testing.T) {
	for _, value := range []string{"", "off", " off "} {
		if enabled, err := teamStepsOptIn(value); enabled || err != nil {
			t.Fatal(value, enabled, err)
		}
	}
	if enabled, err := teamStepsOptIn("on"); !enabled || err != nil {
		t.Fatal(enabled, err)
	}
	if enabled, err := teamStepsOptIn("true"); enabled || err == nil {
		t.Fatal("ambiguous opt-in accepted")
	}
}

func TestStepInputBootstrapRemovesDownloaderWhenOptedOutOrContextDisabled(t *testing.T) {
	for _, tc := range []struct {
		flag, turn string
		ready      bool
	}{{"off", "observe", false}, {"on", "off", false}, {"on", "observe", true}} {
		t.Run(tc.flag+"-"+tc.turn, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			t.Setenv("POCKETCTL_TEAM_STEPS_V1", tc.flag)
			t.Setenv("POCKETCTL_TURN_ENRICHMENT", tc.turn)
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			output := make(chan protocol.DaemonEvent, 4)
			client := ws.NewClient("ws://127.0.0.1:1/ws", "", "daemon", nil, nil, nil, output, logger)
			sm := session.NewSessionManager(output)
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if err := startTeamDelivery(ctx, "ws://127.0.0.1:1/ws", "daemon", client, sm, logger); err != nil {
				t.Fatal(err)
			}
			if sm.TeamStepInputsReady() != tc.ready {
				t.Fatal("step command admission and capability disagree")
			}
		})
	}
}

func testStepInputControl(t *testing.T, control string) {
	// Restore an isolated native ownership fixture. The blocked preparation
	// returns cancellation before any real provider or native CLI is invoked.
	home := t.TempDir()
	t.Setenv("HOME", home)
	output := make(chan protocol.DaemonEvent, 64)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client := ws.NewClient("ws://unused", "token", "daemon", nil, nil, nil, output, logger)
	sm := session.NewSessionManager(output)
	policy, err := session.NewCwdPolicy([]string{t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	sm.SetCwdPolicy(policy)
	auth := &protocol.CollaborationAuthorization{ProtocolVersion: 1, Operation: "message", CallID: "input-call", TeamSessionID: "shared", BindingID: "binding", BindingRevision: 1, OfferID: "offer", OfferRevision: 1, OwnerUserID: 1, DaemonID: "daemon", Delivery: &protocol.TeamDeliveryBinding{TaskID: "task", SpecRevision: 2, AttemptID: "a1234567-1234-4234-8234-123456789abc"}}
	native := "step-control-native"
	bindingHash := sha256.Sum256([]byte(auth.BindingID))
	workspace := filepath.Join(policy.Roots()[0], ".pocketctl", "team", fmt.Sprintf("%x", bindingHash[:12]))
	marker := filepath.Join(home, ".pocketctl", "collaboration-claude", fmt.Sprintf("%x.json", sha256.Sum256([]byte(native))))
	for _, path := range []string{workspace, filepath.Dir(marker)} {
		if err = os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	record, _ := json.Marshal(map[string]any{"Version": 1, "Cwd": workspace, "Binding": map[string]any{"NativeSessionID": native, "TeamSessionID": auth.TeamSessionID, "BindingID": auth.BindingID, "BindingRevision": 1, "OfferID": auth.OfferID, "OfferRevision": 1, "OwnerUserID": 1, "DaemonID": auth.DaemonID, "Agent": adapter.AgentClaude}})
	if err = os.WriteFile(marker, record, 0600); err != nil {
		t.Fatal(err)
	}
	history := filepath.Join(home, ".claude", "projects", regexp.MustCompile(`[^a-zA-Z0-9]`).ReplaceAllString(workspace, "-"))
	if err = os.MkdirAll(history, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(history, native+".jsonl"), []byte("{}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	started, finished := make(chan struct{}), make(chan struct{})
	sm.SetTeamStepInputPreparer(func(ctx context.Context, _ *protocol.CollaborationAuthorization, _, _ string) error {
		close(started)
		<-ctx.Done()
		close(finished)
		return ctx.Err()
	})
	grants := &memorycontext.GrantClient{Timeout: time.Second}
	sent := make(chan struct{}, 1)
	grants.Send = func(context.Context, []byte) error { sent <- struct{}{}; return nil }
	grants.Reply = grants.WaitReply
	sm.SetMemoryContext(&memorycontext.Coordinator{Grants: grants}, func() bool { return false }, func(context.Context, string, string) memorycontext.Capability {
		return memorycontext.CapabilityShadowOnly
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go handleCommands(ctx, client, sm, logger, &atomic.Bool{}, memorymcp.NewWsBroker(client), grants, nil)
	inputHash := sha256.Sum256([]byte("[]"))
	value := &protocol.CollaborationContext{SchemaVersion: 1, ContentHash: strings.Repeat("a", 64), StableText: "step", StepInputHash: hex.EncodeToString(inputHash[:])}
	payload := sha256.Sum256([]byte(value.StableText + "\nstep-inputs:" + value.StepInputHash))
	value.PayloadHash = hex.EncodeToString(payload[:])
	client.CommandCh <- protocol.ClientMessage{Type: "collaboration_user_message", SessionID: native, RequestID: "step-request", MsgID: "step-message", Content: "execute", Collaboration: auth, TeamContext: value, QuotaGrant: &protocol.QuotaGrant{ReservationID: "step-reservation", Operation: "resume", ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("step preparation did not start")
	}
	result := make(chan error, 1)
	go func() {
		_, err := grants.RequestContextGrant(ctx, "control-during-download", "another-session")
		result <- err
	}()
	select {
	case <-sent:
	case <-time.After(time.Second):
		t.Fatal("control request not sent")
	}
	client.CommandCh <- protocol.ClientMessage{Type: "memory_context_grant_result", RequestID: "control-during-download", SessionID: "another-session", Grant: "grant", ExpiresIn: 300, ProviderPublicOrigin: "https://memory.example", GrantServices: []string{"memory.context"}}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("step download blocked the command loop")
	}
	client.CommandCh <- protocol.ClientMessage{Type: control, SessionID: native}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("step preparation ignored cancellation")
	}
}
