package session

import (
	"context"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestPrivateCodexProjectRecoversAfterPipeDisconnect(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 64))
	c := newVerifiedTestCodexCoordinator(sm)
	c.projectCwd, c.codexHomePrimary = t.TempDir(), true
	c.statePath = filepath.Join(t.TempDir(), "project.state")
	first, second := newFakeCodexRuntimeClient(), newFakeCodexRuntimeClient()
	stopped := make(chan struct{}, 1)
	var launches atomic.Int32
	c.start = func(context.Context, string, string, uint64) (*codexAppServerRuntime, error) {
		t.Error("private project used its shared runtime starter")
		return nil, context.Canceled
	}
	c.startPrivateProject = func(_ context.Context, _, _ string, generation uint64) (*codexAppServerRuntime, error) {
		if launches.Add(1) == 2 {
			return nil, errors.New("transient replacement start failure")
		}
		client := second
		if generation == 1 {
			client = first
		}
		return &codexAppServerRuntime{PID: 9999999, ProcessStartIdentity: "fixture", PrivateStdio: true, Client: client,
			Stop: func() error {
				if generation == 1 {
					stopped <- struct{}{}
				}
				return nil
			}}, nil
	}
	c.probe = func(context.Context, *codexAppServerRuntime) error { return context.Canceled }
	caps := agentcontrol.CodexCapabilities{Version: "0.167.1", Core: true, TerminalRemote: true, HiddenContext: true, IdleOnlyContext: true, SchemaHash: "fixture"}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	t.Cleanup(func() { _ = c.shutdown() })
	snapshot, err := c.ensureStarted(ctx, "/fixture/codex", caps.Version, caps)
	if err != nil || snapshot.Generation != 1 || snapshot.RemoteURI != "" || !snapshot.HiddenContext {
		t.Fatalf("initial private project: %+v, %v", snapshot, err)
	}
	c.markSubscribed("durable-thread")
	c.setActiveTurn("durable-thread", "old-turn")
	close(first.events)
	for {
		client, generation, _ := c.backendClient()
		if client == second && generation == 2 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("private project did not replace the disconnected process")
		case <-time.After(5 * time.Millisecond):
		}
	}
	state, err := c.readState()
	if err != nil || !state.PrivateStdio || state.Generation != 2 || state.Endpoint != "" || state.RemoteURI != "" || len(state.Threads) != 1 || state.Threads[0] != "durable-thread" {
		t.Fatalf("recovered project state: %+v, %v", state, err)
	}
	if c.currentTurn("durable-thread") != "" || len(stopped) != 1 {
		t.Fatal("recovered project kept the old process or active turn")
	}
	if launches.Load() != 3 {
		t.Fatalf("expected one failed and one successful replacement, got %d total launches", launches.Load())
	}
}
