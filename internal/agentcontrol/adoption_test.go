//go:build !windows

package agentcontrol

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestAdoptionUsesPrivateDaemonIPC(t *testing.T) {
	endpoint := filepath.Join(t.TempDir(), "control.sock")
	// Darwin sockaddr_un limits can be shorter than the Go test directory.
	if len(endpoint) > 95 {
		dir := shortAdoptionSocket(t)
		endpoint = filepath.Join(dir, "s")
	}
	server := NewServer(endpoint, nil)
	observed := make(chan protocol.AdoptionRequest, 1)
	server.Adoption = func(_ context.Context, method string, req protocol.AdoptionRequest) (protocol.AdoptionReceipt, error) {
		if method != MethodAdopt {
			t.Errorf("unexpected method %s", method)
		}
		observed <- req
		return protocol.AdoptionReceipt{SessionID: req.SessionID, OperationID: "op", Phase: "checking"}, nil
	}
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req := protocol.AdoptionRequest{SessionID: "thread", RequestID: "click", WaitMS: 2500, Unarchive: true}
	r, err := NewAgentClient(endpoint, AgentCodex).AdoptSession(ctx, MethodAdopt, req)
	if err != nil {
		t.Fatal(err)
	}
	got := <-observed
	if r.OperationID != "op" || got != req {
		t.Fatalf("receipt %+v, request %+v, err %v", r, got, err)
	}
	if _, err := NewAgentClient(endpoint, AgentOpenCode).AdoptSession(ctx, MethodAdopt, req); err == nil {
		t.Fatal("wrong agent accepted")
	}
}
func shortAdoptionSocket(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "pca-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}
