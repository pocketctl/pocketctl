//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/update"
)

func TestUpdateSudoAuthorizationAndInstallBoundary(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("requires ordinary user")
	}
	target, err := filepath.EvalSymlinks("/bin/ls")
	if err != nil {
		t.Skip(err)
	}
	if err := update.ValidateElevatedExecutable(target); err != nil {
		t.Skip(err)
	}
	dir := t.TempDir()
	sudo := filepath.Join(dir, "sudo")
	record := filepath.Join(dir, "args")
	t.Setenv("UPDATE_TEST_RECORD", record)
	t.Setenv("PATH", dir)
	t.Setenv("TERM", "dumb")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$UPDATE_TEST_RECORD\"\nexit 1\n"
	if err := os.WriteFile(sudo, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareUpdateInstall(target); err == nil {
		t.Fatal("authorization failure ignored")
	}
	args, _ := os.ReadFile(record)
	if string(args) != "-n\n-v\n" {
		t.Fatalf("noninteractive sudo may wait for password: %q", args)
	}
	script = strings.Replace(script, "exit 1", "exit 0", 1)
	os.WriteFile(sudo, []byte(script), 0700)
	prepared, err := prepareUpdateInstall(target)
	if err != nil {
		t.Fatal(err)
	}
	if err := installDownloadedUpdate(prepared, target, "/tmp/source with spaces", "v0.5.8", ""); err != nil {
		t.Fatal(err)
	}
	args, _ = os.ReadFile(record)
	want := "-n\n--\n" + target + "\n__install_update\nv0.5.8\n/tmp/source with spaces\n"
	if string(args) != want {
		t.Fatalf("unexpected privileged operation: %q", args)
	}
}

func TestUpdateUserInstallDoesNotRequestSudo(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pocketctl")
	os.WriteFile(path, []byte("test"), 0755)
	t.Setenv("PATH", t.TempDir())
	sudo, err := prepareUpdateInstall(path)
	if err != nil || sudo != "" {
		t.Fatalf("unnecessary sudo: %q %v", sudo, err)
	}
}

func TestPrivilegedInstallerRejectsOrdinaryUser(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("requires ordinary user")
	}
	if err := runPrivilegedUpdateInstall([]string{"v0.5.8", "/tmp/missing"}); err == nil {
		t.Fatal("ordinary user entered privileged installer")
	}
}
