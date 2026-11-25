package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestZcodeQuotaCLIRejectsKeyOnCommandLine(t *testing.T) {
	var stdout, stderr bytes.Buffer
	err := runAgentCommand([]string{"zcode", "quota", "bind", "secret-fixture"}, &stdout, &stderr, nil)
	if err == nil || strings.Contains(err.Error()+stdout.String()+stderr.String(), "secret-fixture") {
		t.Fatal("key argument must be rejected without echo")
	}
}

func TestZcodeQuotaCLIBindValidatesStdin(t *testing.T) {
	p := filepath.Join(t.TempDir(), "input")
	if err := os.WriteFile(p, []byte("key\nsecond-line\n"), 0600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var stdout, stderr bytes.Buffer
	err = runZcodeQuotaCommand([]string{"bind"}, f, &stdout, &stderr)
	if err == nil || err.Error() != "invalid Coding Plan API key" || stdout.Len() != 0 || stderr.Len() != 0 {
		t.Fatalf("unexpected command result: %v", err)
	}
}
