package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestCollaborationClaudeRegistersBeforePrintAndPreservesHiddenContext(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	installSentinelResumeCLI(t, "claude")
	output := make(chan protocol.DaemonEvent, 128)
	sm := NewSessionManager(output)
	policy, err := NewCwdPolicy([]string{t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	sm.SetCwdPolicy(policy)
	starter := newRecordingResumeStarter()
	sm.setResumeStarter(starter.call)
	defer starter.finishAll()
	text := "CONTEXT_ONLY_SECRET"
	digest := sha256.Sum256([]byte(text))
	shared := &protocol.CollaborationContext{SchemaVersion: 1, ContextVersion: 1,
		ContentHash: strings.Repeat("a", 64), PayloadHash: hex.EncodeToString(digest[:]), StableText: text}
	registered := false
	id, err := sm.CreateCollaborationSessionRegistered(context.Background(), collaborationAuth("create", "first"), shared,
		adapter.AgentClaude, "EXACT_USER_INPUT", func(_ context.Context, id string) error {
			if specs, _ := starter.snapshot(); len(specs) != 0 {
				t.Fatal("provider executed before registration")
			}
			if sm.sessions[id].PTY != nil {
				t.Fatal("Team receiver opened an interactive startup terminal")
			}
			registered = true
			return nil
		})
	if err != nil || !registered {
		t.Fatalf("create: id=%s error=%v registered=%v", id, err, registered)
	}
	specs, procs := starter.snapshot()
	if len(specs) != 1 {
		t.Fatalf("launches=%d", len(specs))
	}
	args := specs[0].Args
	if !strings.Contains(strings.Join(args, " "), "--session-id "+id) || strings.Contains(strings.Join(args, " "), "--resume") {
		t.Fatalf("first launch: %v", args)
	}
	for i, arg := range args {
		if strings.Contains(arg, text) && (i == 0 || args[i-1] != "--append-system-prompt") {
			t.Fatalf("context in visible args: %v", args)
		}
	}
	if !strings.Contains(strings.Join(args, " "), text) {
		t.Fatal("shared system context dropped")
	}
	procs[0].release(nil)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		sm.mu.RLock()
		finished := sm.sessions[id].Status == protocol.StatusCompleted
		sm.mu.RUnlock()
		if finished {
			break
		}
		time.Sleep(time.Millisecond)
	}
	auth := collaborationAuth("message", "second")
	if err := sm.DispatchCollaborationMessage(context.Background(), auth, shared, id, "SECOND_EXACT_INPUT", "second", "second"); err != nil {
		t.Fatal(err)
	}
	specs, _ = starter.snapshot()
	if len(specs) != 2 || !strings.Contains(strings.Join(specs[1].Args, " "), "--resume "+id) {
		t.Fatalf("continuation: %v", specs)
	}
	if err := sm.DispatchCollaborationMessage(context.Background(), auth, shared, id, "SECOND_EXACT_INPUT", "second", "second"); !errors.Is(err, ErrCollaborationDuplicateCall) {
		t.Fatalf("duplicate: %v", err)
	}
	for len(output) > 0 {
		if e := <-output; e.Type == "user_text" && strings.Contains(e.Text, text) {
			t.Fatal("hidden context exposed in user event")
		}
	}
}

func TestCollaborationClaudeRestoreRequiresExactDurableOwnership(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 32))
	policy, _ := NewCwdPolicy([]string{t.TempDir()})
	sm.SetCwdPolicy(policy)
	auth := collaborationAuth("message", "after-restart")
	id := "owned-claude-native"
	cwd := collaborationWorkspace(policy.Roots()[0], auth.BindingID)
	if err := os.MkdirAll(cwd, 0700); err != nil {
		t.Fatal(err)
	}
	ps := &ProcessState{SessionID: id, Agent: adapter.AgentClaude, Cwd: cwd, Source: "terminal", Status: protocol.StatusExited}
	sm.sessions[id] = ps
	if sm.restoreCollaborationClaude(auth, id, ps, policy) != nil {
		t.Fatal("terminal history granted ownership without marker")
	}
	binding := collaborationNativeBinding{NativeSessionID: id, TeamSessionID: auth.TeamSessionID, BindingID: auth.BindingID,
		BindingRevision: auth.BindingRevision, OfferID: auth.OfferID, OfferRevision: auth.OfferRevision, OwnerUserID: auth.OwnerUserID, DaemonID: auth.DaemonID, Agent: adapter.AgentClaude}
	if err := persistCollaborationNative(binding, cwd); err != nil {
		t.Fatal(err)
	}
	if sm.restoreCollaborationClaude(auth, id, ps, policy) != nil {
		t.Fatal("marker without native history restored")
	}
	dir := filepath.Join(os.Getenv("HOME"), ".claude", "projects", regexp.MustCompile(`[^a-zA-Z0-9]`).ReplaceAllString(cwd, "-"))
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte("{}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	foreign := *auth
	foreign.OwnerUserID++
	if sm.restoreCollaborationClaude(&foreign, id, ps, policy) != nil {
		t.Fatal("foreign owner granted existing marker")
	}
	if sm.restoreCollaborationClaude(auth, id, ps, policy) != ps || ps.Source != "daemon" || !ps.ClaudePrintStarted {
		t.Fatal("exact owner and native history did not restore")
	}
	delete(sm.sessions, id)
	if restored := sm.restoreCollaborationClaude(auth, id, nil, policy); restored == nil || restored.Source != "daemon" || !restored.ClaudePrintStarted {
		t.Fatal("a fresh manager did not hydrate the exact durably owned receiver")
	}
}

func TestCollaborationClaudeRegistrationFailureNeverExecutes(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	installSentinelResumeCLI(t, "claude")
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 32))
	policy, _ := NewCwdPolicy([]string{t.TempDir()})
	sm.SetCwdPolicy(policy)
	starter := newRecordingResumeStarter()
	sm.setResumeStarter(starter.call)
	_, err := sm.CreateCollaborationSessionRegistered(context.Background(), collaborationAuth("create", "failed"), nil, adapter.AgentClaude, "must not execute", func(context.Context, string) error { return errors.New("registration failed") })
	if err == nil {
		t.Fatal("registration failure accepted")
	}
	if specs, _ := starter.snapshot(); len(specs) != 0 {
		t.Fatal("provider executed after failed registration")
	}
	if len(sm.sessions) != 0 {
		t.Fatal("failed receiver reservation survived")
	}
}
