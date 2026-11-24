//go:build !windows

package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/discovery"
)

// Exercise the npm retirement layout with a real package manager and a
// loopback-only registry. The package and the installation prefix are fixtures.
func TestInstalledNPMInterruptedCodexUpgrade(t *testing.T) {
	if os.Getenv("POCKETCTL_NPM_UPGRADE_SMOKE") != "1" {
		t.Skip("opt-in npm smoke")
	}
	home := t.TempDir()
	prefix := filepath.Join(home, "prefix")
	t.Setenv("HOME", home)
	t.Setenv("NPM_CONFIG_USERCONFIG", os.DevNull)
	t.Setenv("NPM_CONFIG_GLOBALCONFIG", filepath.Join(home, "empty-npmrc"))
	t.Setenv("NPM_CONFIG_CACHE", filepath.Join(home, "cache"))
	t.Setenv("NPM_CONFIG_PREFIX", prefix)
	t.Setenv("NPM_CONFIG_AUDIT", "false")
	t.Setenv("NPM_CONFIG_UPDATE_NOTIFIER", "false")
	t.Setenv("NPM_CONFIG_FETCH_RETRIES", "0")
	const pkg = "@openai/codex"
	manifest := func(version string) map[string]any {
		return map[string]any{"name": pkg, "version": version, "bin": map[string]string{"codex": "bin/codex.js"}}
	}
	pack := func(version string) []byte {
		var buf bytes.Buffer
		gz := gzip.NewWriter(&buf)
		tw := tar.NewWriter(gz)
		data, _ := json.Marshal(manifest(version))
		for path, content := range map[string]string{"package/package.json": string(data), "package/bin/codex.js": "#!/bin/sh\necho codex-cli " + version + "\n"} {
			if err := tw.WriteHeader(&tar.Header{Name: path, Size: int64(len(content)), Mode: 0755}); err != nil {
				t.Fatal(err)
			}
			if _, err := tw.Write([]byte(content)); err != nil {
				t.Fatal(err)
			}
		}
		if err := tw.Close(); err != nil {
			t.Fatal(err)
		}
		if err := gz.Close(); err != nil {
			t.Fatal(err)
		}
		return buf.Bytes()
	}
	const old = "0.171.0"
	const next = "0.172.0"
	oldFile := filepath.Join(home, "old.tgz")
	if err := os.WriteFile(oldFile, pack(old), 0600); err != nil {
		t.Fatal(err)
	}
	archive := pack(next)
	var block atomic.Bool
	block.Store(true)
	fetching := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/new.tgz" {
			if block.Load() {
				select {
				case fetching <- struct{}{}:
				default:
				}
				<-r.Context().Done()
				return
			}
			_, _ = w.Write(archive)
			return
		}
		m := manifest(next)
		m["dist"] = map[string]string{"tarball": "http://" + r.Host + "/new.tgz"}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"name": pkg, "versions": map[string]any{next: m}, "dist-tags": map[string]string{"latest": next}})
	}))
	defer server.Close()
	t.Setenv("NPM_CONFIG_REGISTRY", server.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "npm", "install", "-g", "--prefix", prefix, oldFile).CombinedOutput(); err != nil {
		t.Fatalf("seed: %v %s", err, out)
	}
	install, stop := context.WithCancel(ctx)
	defer stop()
	done := make(chan error, 1)
	go func() {
		out, err := runAgentUpgrade(install, "", "", pkg, prefix)
		if err != nil {
			err = fmt.Errorf("%w %s", err, out)
		}
		done <- err
	}()
	select {
	case <-fetching:
		stop()
	case err := <-done:
		t.Fatalf("unexpected early exit: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if restored, err := discovery.RecoverCodexNPM(prefix); err != nil || !restored {
		dirs, _ := os.ReadDir(filepath.Join(prefix, "lib", "node_modules", "@openai"))
		real, _ := filepath.EvalSymlinks(prefix)
		t.Fatalf("restore=%v err=%v prefix=%q real=%q contents=%v", restored, err, prefix, real, dirs)
	}
	link := filepath.Join(prefix, "bin", "codex")
	if v, err := discovery.VerifyCodexNPMVersion(prefix, link); err != nil || v != old {
		t.Fatalf("restored version=%q err=%v", v, err)
	}
	block.Store(false)
	if out, err := runAgentUpgrade(ctx, "", "", pkg, prefix); err != nil {
		t.Fatalf("retry: %v %s", err, out)
	}
	if v, err := discovery.VerifyCodexNPMVersion(prefix, link); err != nil || v != next {
		t.Fatalf("retried version=%q err=%v", v, err)
	}
}
