package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/memorysync"
)

func TestMemoryScopesJSONAndLegacyWarning(t *testing.T) {
	var stdout, stderr bytes.Buffer
	list := func(context.Context) (memorysync.ScopeList, error) {
		return memorysync.ScopeList{Scopes: []memorysync.Scope{{InstallationID: "installation-id", Kind: "personal", Name: "my\nname", Status: "active", Permissions: []string{}}}}, nil
	}
	if code := runMemoryScopesWith(&stdout, &stderr, []string{"--json"}, list); code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, &stderr)
	}
	var parsed memorysync.ScopeList
	if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil || len(parsed.Scopes) != 1 || parsed.SharedScopesAvailable {
		t.Fatalf("stdout=%s err=%v", &stdout, err)
	}
	if !strings.Contains(stderr.String(), "only personal") {
		t.Fatalf("missing legacy warning: %s", &stderr)
	}
	stdout.Reset()
	stderr.Reset()
	if code := runMemoryScopesWith(&stdout, &stderr, nil, list); code != 0 {
		t.Fatal(code)
	}
	if !strings.Contains(stdout.String(), "INSTALLATION_ID") || !strings.Contains(stdout.String(), `my\nname`) {
		t.Fatalf("unsafe table output: %s", &stdout)
	}
}

func TestMemoryScopesHelpAndBadFlagsNeverLoadCredentials(t *testing.T) {
	for _, args := range [][]string{{"--help"}, {"--unknown"}} {
		var stdout, stderr bytes.Buffer
		code := runMemoryScopesWith(&stdout, &stderr, args, func(context.Context) (memorysync.ScopeList, error) {
			t.Fatal("discovery must not run")
			return memorysync.ScopeList{}, nil
		})
		if args[0] == "--help" && code != 0 || args[0] == "--unknown" && code != 2 {
			t.Fatalf("args=%v code=%d", args, code)
		}
	}
}

func TestMemoryScopesErrorsDoNotPrintSuccessOutput(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := runMemoryScopesWith(&stdout, &stderr, nil, func(context.Context) (memorysync.ScopeList, error) {
		return memorysync.ScopeList{}, fmt.Errorf("not_logged_in")
	})
	if code != 1 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "not_logged_in") {
		t.Fatalf("exit=%d out=%s err=%s", code, &stdout, &stderr)
	}
}
