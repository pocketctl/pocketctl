package repositoryidentity

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
)

func TestCanonicalRemoteRejectsPathDerivedAndTraversalIdentities(t *testing.T) {
	for _, remote := range []string{
		"/Users/example/project",
		"../relative/project.git",
		"file:///Users/example/project.git",
		"https://gitee.com/team/../secret.git",
	} {
		if got, ok := canonicalRemote(remote); ok {
			t.Fatalf("canonicalRemote(%q) = %q, want rejected", remote, got)
		}
	}
}

func TestCanonicalRemoteStripsCredentialsAndTransportSyntax(t *testing.T) {
	for _, remote := range []string{
		"https://user:token@gitee.com/muwb123/pocketctl.git",
		"git@gitee.com:muwb123/pocketctl.git",
		"ssh://git@gitee.com/muwb123/pocketctl.git",
	} {
		if got, ok := canonicalRemote(remote); !ok || got != "gitee.com/muwb123/pocketctl" {
			t.Fatalf("canonicalRemote(%q) = %q, %v", remote, got, ok)
		}
	}
}

func TestResolveStartsIndependentGitReadsTogether(t *testing.T) {
	output := map[string]string{
		"remote":       "https://example.test/team/repository.git",
		"symbolic-ref": "main",
		"rev-parse":    "0123456789012345678901234567890123456789",
	}
	var started atomic.Int32
	allStarted := make(chan struct{})
	got, ok := resolve(context.Background(), "repository", func(ctx context.Context, _ string, args ...string) (string, error) {
		if started.Add(1) == int32(len(output)) {
			close(allStarted)
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-allStarted:
			return output[args[0]], nil
		}
	})
	want := Observation{RepositoryID: "example.test/team/repository", Branch: "main", CommitSHA: output["rev-parse"]}
	if !ok || got != want {
		t.Fatalf("observation = %#v, %v; want %#v", got, ok, want)
	}
}

func TestResolveRetainsCommitForDetachedHead(t *testing.T) {
	got, ok := resolve(context.Background(), "repository", func(_ context.Context, _ string, args ...string) (string, error) {
		switch args[0] {
		case "remote":
			return "https://example.test/team/repository.git", nil
		case "rev-parse":
			return "0123456789012345678901234567890123456789", nil
		default:
			return "", errors.New("detached head")
		}
	})
	if !ok || got.RepositoryID != "example.test/team/repository" || got.Branch != "" || got.CommitSHA == "" {
		t.Fatalf("expected repository and commit for detached head, got %#v, %v", got, ok)
	}
}
