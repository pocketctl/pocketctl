package session

import (
	"context"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/ptyscan"
	"os"
	"testing"
)

func TestPTYExitPublishesChoiceCancellation(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	output := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(output)
	ps := &ProcessState{SessionID: "s", PTY: choiceTestPTY{reader}, PTYScanner: ptyscan.NewScanner("s")}
	writer.WriteString("Do you want to proceed?\n❯ 1. Yes\n  2. No\n")
	writer.Close()
	sm.drainPTY(context.Background(), ps)
	if len(output) != 2 {
		t.Fatalf("events=%d, want prompt then cancellation", len(output))
	}
	prompt, closed := <-output, <-output
	if prompt.Type != "interactive_prompt" || closed.Type != "interactive_resolved" || closed.RequestID != prompt.RequestID || closed.Status != "cancelled" {
		t.Fatalf("closure=%s/%s", closed.Type, closed.Status)
	}
	if ps.PTYScanner.ActivePrompt() != nil {
		t.Fatal("dead PTY still accepts input")
	}
}

type choiceTestPTY struct{ *os.File }

func (choiceTestPTY) SetSize(uint16, uint16) error { return nil }
