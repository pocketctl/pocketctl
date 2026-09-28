package session

import (
	"bytes"
	"context"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/ptyscan"
	"testing"
	"time"
)

func TestPTYInitialPromptWaitsForOwnerAndCancellation(t *testing.T) {
	scanner := ptyscan.NewScanner("startup")
	scanner.Feed([]byte("Do you want to proceed?\n1. Yes\n2. No"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	ready := make(chan bool, 1)
	go func() { ready <- waitForPTYPromptReady(ctx, done, scanner) }()
	select {
	case <-ready:
		t.Fatal("task became ready while owner prompt pending")
	case <-time.After(1200 * time.Millisecond):
	}
	cancel()
	select {
	case ok := <-ready:
		if ok {
			t.Fatal("cancellation allowed task submission")
		}
	case <-time.After(time.Second):
		t.Fatal("pending owner prompt ignored cancellation")
	}
}

func TestPTYPromptUsesBracketedPasteThenSeparateEnter(t *testing.T) {
	var output bytes.Buffer
	_, err := writePTYPrompt(context.Background(), &output, "Context line 1\nTask line 2")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := output.String(), "\x1b[200~Context line 1\nTask line 2\x1b[201~\r"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestPTYOwnerChoiceEmitsSubmittedReceipt(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 2)
	sm := NewSessionManager(output)
	terminal := &interruptPTY{}
	scanner := ptyscan.NewScanner("owned")
	scanner.Feed([]byte("Do you want to proceed?\n1. Yes\n2. No"))
	id := scanner.ActiveRequestID()
	sm.sessions["owned"] = &ProcessState{SessionID: "owned", Agent: "claude-code", Source: "daemon", PTY: terminal, PTYScanner: scanner}
	if err := sm.ResolveInteractivePrompt("owned", id, "1"); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-output:
		if event.Type != "interaction_result" || event.Status != "submitted" || event.Choice != "1" || event.RequestID != id {
			t.Fatalf("receipt: %+v", event)
		}
	default:
		t.Fatal("missing submitted receipt")
	}
	if err := sm.ResolveInteractivePrompt("owned", id, "1"); err == nil {
		t.Fatal("duplicate choice accepted")
	}
	if got := terminal.String(); got != "1\r" {
		t.Fatalf("terminal: %q", got)
	}
}
