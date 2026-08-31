package repositoryidentity

import "testing"

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
