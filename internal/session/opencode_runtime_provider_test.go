package session

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestOpenCodeRuntimeProviderDisabledReturnsNative(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	real := filepath.Join(home, "opencode")
	real = writeFakeCommandFixture(t, real,
		"#!/bin/sh\nexit 0\n",
		"@echo off\nexit /B 0\n",
	)
	cfg := agentcontrol.DefaultConfig()
	cfg.OpenCode.State = agentcontrol.StateDisabled
	cfg.OpenCode.RealBinary = real
	if err := agentcontrol.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	result, err := sm.Acquire(context.Background(), agentcontrol.AcquireRequest{
		Agent:   agentcontrol.AgentOpenCode,
		Payload: agentcontrol.AcquirePayload{CWD: home, Intent: agentcontrol.IntentNew, OperationID: "op-1"},
	})
	if err != nil || result.Mode != string(agentcontrol.LaunchNative) || result.RealBinary != real {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

var _ agentcontrol.RuntimeProvider = (*SessionManager)(nil)
