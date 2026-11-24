//go:build !windows

package discovery

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRecoverInterruptedCodexNPM(t *testing.T) {
	if got := filepath.Base(npmRetiredPackage("/opt/homebrew/lib/node_modules/@openai/codex")); got != ".codex-QDftHxCm" {
		t.Fatal(got)
	}
	for _, tc := range []struct {
		name                          string
		manifest, foreignLink, broken bool
	}{
		{name: "partial"}, {name: "existing installation", manifest: true}, {name: "foreign launcher", foreignLink: true}, {name: "incomplete backup", broken: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prefix, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			dir := filepath.Join(prefix, "lib", "node_modules", "@openai", "codex")
			old := npmRetiredPackage(dir)
			retained := filepath.Join(filepath.Dir(dir), ".codex-0.171.0-retired-in-use")
			for _, p := range []string{dir, retained, filepath.Join(old, "bin"), filepath.Join(prefix, "bin")} {
				if err := os.MkdirAll(p, 0755); err != nil {
					t.Fatal(err)
				}
			}
			write := func(p, s string) {
				t.Helper()
				if err := os.WriteFile(p, []byte(s), 0755); err != nil {
					t.Fatal(err)
				}
			}
			write(filepath.Join(old, "package.json"), `{"name":"@openai/codex","version":"0.171.0"}`)
			if !tc.broken {
				write(filepath.Join(old, "bin", "codex.js"), "#!/bin/sh\necho 'codex-cli 0.171.0'\n")
			}
			write(filepath.Join(dir, "partial"), "partial")
			if tc.manifest {
				write(filepath.Join(dir, "package.json"), "{}")
			}
			link := filepath.Join(prefix, "bin", "codex")
			if tc.foreignLink {
				write(link, "other")
			}
			want := !(tc.manifest || tc.foreignLink || tc.broken)
			got, err := RecoverCodexNPM(prefix)
			if got != want || (err == nil) != want {
				t.Fatalf("restored=%v error=%v", got, err)
			}
			if _, err := os.Stat(retained); err != nil {
				t.Fatal(err)
			}
			if !want {
				if _, err := os.Stat(filepath.Join(dir, "partial")); err != nil {
					t.Fatal(err)
				}
				return
			}
			if v, err := VerifyCodexNPMVersion(prefix, link); err != nil || v != "0.171.0" {
				t.Fatalf("v=%q err=%v", v, err)
			}
			if got, err := RecoverCodexNPM(prefix); got || err != nil {
				t.Fatalf("retry restored=%v err=%v", got, err)
			}
		})
	}
}
