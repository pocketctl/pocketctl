package teamcode

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"github.com/pocketctl/pocketctl/internal/sessiondocument"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestThreeWorkspacesMergeFrozenInputs(t *testing.T) {
	ctx := context.Background()
	run := func(dir string, args ...string) string {
		t.Helper()
		out, e := git(ctx, dir, args...)
		if e != nil {
			t.Fatal(e)
		}
		return strings.TrimSpace(string(out))
	}
	put := func(file string, b []byte) {
		t.Helper()
		if e := os.MkdirAll(filepath.Dir(file), 0700); e != nil {
			t.Fatal(e)
		}
		if e := os.WriteFile(file, b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	repo := t.TempDir()
	run(repo, "init", "--quiet", "--template=")
	put(filepath.Join(repo, "README"), []byte("base"))
	run(repo, "add", "README")
	run(repo, "commit", "-qm", "baseline")
	base := run(repo, "rev-parse", "HEAD")
	all := []string{"relay", "web", "ios"}
	auth := func(id, kind string, paths []string) *protocol.CollaborationAuthorization {
		return &protocol.CollaborationAuthorization{CallID: "call-" + id, BindingID: "binding", OfferID: "offer", Delivery: &protocol.TeamDeliveryBinding{AttemptID: id, Code: &protocol.TeamCodeStep{TeamCodeScope: protocol.TeamCodeScope{Repository: "team/project", BaseSHA: base, Paths: paths}, Kind: kind}}}
	}
	type output struct {
		s     source
		files map[string][]byte
	}
	prepare := func(dir string, a *protocol.CollaborationAuthorization, inputs []output) error {
		sources := []source{}
		prefix := filepath.Join(dir, ".pocketctl-inputs", digest([]byte(a.CallID)))
		for _, out := range inputs {
			sources = append(sources, out.s)
			for id, b := range out.files {
				put(filepath.Join(prefix, "files", digest([]byte(out.s.Attempt+"/"+out.s.Submission+"/"+id))), b)
			}
		}
		encoded, _ := json.Marshal(sources)
		a.Delivery.Code.InputHash = digest(encoded)
		a.Delivery.Code.LeaseGeneration = 1
		a.Delivery.Code.Upstream = nil
		for _, s := range sources {
			a.Delivery.Code.Upstream = append(a.Delivery.Code.Upstream, protocol.TeamCodeDependency{StepID: s.Step, AttemptID: s.Attempt, SubmissionID: s.Submission})
		}
		data, _ := json.Marshal(map[string]any{"input_hash": a.Delivery.Code.InputHash, "call_id": a.CallID, "attempt_id": a.Delivery.AttemptID, "inputs": sources})
		put(filepath.Join(prefix, "inputs.json"), data)
		return Prepare(ctx, dir, repo, a)
	}
	export := func(dir string, a *protocol.CollaborationAuthorization) output {
		t.Helper()
		m, b, e := Export(ctx, dir, a)
		if e != nil {
			t.Fatal(e)
		}
		data, _ := json.Marshal(m)
		files := map[string][]byte{ManifestID: data, BundleID: b}
		s := source{Step: a.CallID, Call: a.CallID, Attempt: a.Delivery.AttemptID, Submission: "submission-" + a.CallID, Head: m.Head, Code: a.Delivery.Code}
		for id, b := range files {
			s.Artifacts = append(s.Artifacts, protocol.TeamDeliveryArtifact{ID: id, ByteSize: len(b), SHA256: digest(b)})
		}
		return output{s, files}
	}
	var branches []output
	for _, scope := range all {
		dir := t.TempDir()
		a := auth(scope, "develop", []string{scope})
		if e := prepare(dir, a, nil); e != nil {
			t.Fatal(e)
		}
		path := scope + "/feature"
		put(filepath.Join(dir, path), []byte(scope))
		run(dir, "add", path)
		run(dir, "commit", "-qm", "change "+scope)
		branches = append(branches, export(dir, a))
		put(filepath.Join(dir, "private"), []byte("private"))
		run(dir, "add", "private")
		run(dir, "commit", "-qm", "out of scope")
		run(dir, "rm", "private")
		run(dir, "commit", "-qm", "revert")
		if _, _, e := Export(ctx, dir, a); e == nil {
			t.Fatal("export accepted out-of-scope intermediate commit")
		}
	}
	if e := prepare(t.TempDir(), auth("narrow", "merge", []string{"web"}), branches); e == nil {
		t.Fatal("import permitted an upstream change outside the receiving grant")
	}
	merge := auth("merge", "merge", all)
	merged := t.TempDir()
	if e := prepare(merged, merge, branches); e != nil {
		t.Fatal(e)
	}
	for _, p := range all {
		if _, e := os.Stat(filepath.Join(merged, p, "feature")); e != nil {
			t.Fatal(e)
		}
	}
	verified := t.TempDir()
	accept := auth("verify", "verify", all)
	integrated := export(merged, merge)
	if e := prepare(verified, accept, []output{integrated}); e != nil {
		t.Fatal(e)
	}
	if run(verified, "rev-parse", "HEAD") != integrated.s.Head || run(repo, "rev-parse", "HEAD") != base || run(repo, "status", "--porcelain") != "" {
		t.Fatal("checkout identity changed")
	}
	integrated.files[BundleID] = []byte("damaged")
	if e := prepare(t.TempDir(), accept, []output{integrated}); e == nil {
		t.Fatal("import accepted corrupted bundle")
	}
	var competing []output
	for _, name := range []string{"left", "right"} {
		dir := t.TempDir()
		a := auth(name, "develop", []string{"web"})
		if e := prepare(dir, a, nil); e != nil {
			t.Fatal(e)
		}
		put(filepath.Join(dir, "web", "shared"), []byte(name))
		run(dir, "add", "web")
		run(dir, "commit", "-qm", name)
		competing = append(competing, export(dir, a))
	}
	if e := prepare(t.TempDir(), auth("conflict", "merge", all), competing); e == nil || !strings.Contains(e.Error(), "web/shared") {
		t.Fatalf("expected conflict path, got %v", e)
	}
	dir := t.TempDir()
	a := auth("large", "develop", []string{"web"})
	if e := prepare(dir, a, nil); e != nil {
		t.Fatal(e)
	}
	payload := make([]byte, maxBundle+4096)
	if _, e := rand.Read(payload); e != nil {
		t.Fatal(e)
	}
	put(filepath.Join(dir, "web", "large"), payload)
	run(dir, "add", "web")
	run(dir, "commit", "-qm", "large")
	if _, _, e := Export(ctx, dir, a); !errors.Is(e, sessiondocument.ErrArtifactTooLarge) {
		t.Fatalf("oversized Git bundle: %v", e)
	}

}

func TestOwnerGrantInventory(t *testing.T) {
	ctx := context.Background()
	repo, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "--quiet", "--template="}, {"commit", "--allow-empty", "-qm", "base"}} {
		if _, e := git(ctx, repo, args...); e != nil {
			t.Fatal(e)
		}
	}
	head, e := git(ctx, repo, "rev-parse", "HEAD")
	if e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(t.TempDir(), "team-code-workspaces.json")
	grant := localGrant{Provider: "codex", Directory: repo, RequireSandbox: true, TeamCodeGrant: protocol.TeamCodeGrant{TeamID: "team", OfferID: "offer", TeamCodeScope: protocol.TeamCodeScope{Repository: "team/project", BaseSHA: strings.TrimSpace(string(head)), Paths: []string{"web"}, Tools: []string{"git"}}}}
	write := func() {
		t.Helper()
		data, e := json.Marshal([]localGrant{grant})
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(path, data, 0600); e != nil {
			t.Fatal(e)
		}
	}
	write()
	allows := func(path string) error {
		if path == repo {
			return nil
		}
		return os.ErrPermission
	}
	first := readGrants(ctx, path, "codex", allows)
	if len(first) != 1 {
		t.Fatal("authorized repository was not advertised")
	}
	wire, _ := json.Marshal(first[0].TeamCodeGrant)
	if strings.Contains(string(wire), repo) {
		t.Fatal("local path disclosed")
	}
	grant.Paths = []string{"ios"}
	write()
	next := readGrants(ctx, path, "codex", allows)
	if len(next) != 1 || next[0].GrantRevision == first[0].GrantRevision {
		t.Fatal("scope change did not fence the old grant")
	}
	if len(readGrants(ctx, path, "codex", func(string) error { return os.ErrPermission })) != 0 {
		t.Fatal("repository outside allowlist advertised")
	}
	if e := os.Chmod(path, 0644); e != nil {
		t.Fatal(e)
	}
	if len(readGrants(ctx, path, "codex", allows)) != 0 {
		t.Fatal("nonprivate grant file accepted")
	}
}
