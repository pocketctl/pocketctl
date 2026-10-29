package agentteams

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMCPProcessNeverRunsAnUnapprovedToolOrReturnsCredentialErrors(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "executed")
	script := filepath.Join(t.TempDir(), "python-fixture")
	// A process double is necessary to verify the subprocess boundary without
	// starting an external service. The fixed program records real execution.
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf executed > '"+marker+"'\nprintf 'private-token' >&2\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	m, err := NewMCPProcess([]string{script}, "/private/config.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Call(context.Background(), "workerflow", map[string]any{"action": "create_worker"}); !errors.Is(err, ErrIdentity) {
		t.Fatal(err)
	}
	if _, err = os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("unapproved tool launched a process")
	}
	_, err = m.Call(context.Background(), "projectflow", map[string]any{"action": "create_project", "projectId": "pctl-safe"})
	if !errors.Is(err, ErrTransport) || strings.Contains(err.Error(), "private-token") {
		t.Fatal("private subprocess error exposed", err)
	}
	if _, err = os.Stat(marker); err != nil {
		t.Fatal("approved process was not executed")
	}
}
