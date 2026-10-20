package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/i18n"
	"github.com/pocketctl/pocketctl/internal/update"
)

// prepareUpdateInstall runs before any download or process stop. Only the
// installation child is elevated; this process keeps the original UID/HOME.
func prepareUpdateInstall(path string) (string, error) {
	needs, err := update.NeedsElevation(path)
	if err != nil || !needs {
		return "", err
	}
	if err := update.ValidateElevatedExecutable(path); err != nil {
		return "", err
	}
	sudo, err := exec.LookPath("sudo")
	if err != nil {
		return "", err
	}
	fmt.Println(i18n.T("update.sudo_required", path))
	args := []string{"-v"}
	if !updateTerminal() {
		args = []string{"-n", "-v"}
	}
	cmd := exec.Command(sudo, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%s: %w", i18n.T("update.sudo_failed"), err)
	}
	return sudo, nil
}

func installDownloadedUpdate(sudo, path, source, tag, sha string) error {
	if sudo == "" {
		return update.InstallVerified(source, path, sha)
	}
	args := []string{}
	if !updateTerminal() {
		args = append(args, "-n")
	}
	args = append(args, "--", path, "__install_update", tag, source)
	cmd := exec.Command(sudo, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

// runPrivilegedUpdateInstall has no daemon/config access. The privileged child
// independently resolves the official digest and verifies a root-owned staged
// copy, preventing substitution of the user's download after verification.
func runPrivilegedUpdateInstall(args []string) error {
	if len(args) != 2 || !update.IsElevated() {
		return fmt.Errorf("internal installer requires root and a release tag/source")
	}
	path, err := update.ExecutablePath()
	if err != nil {
		return err
	}
	if err := update.ValidateElevatedExecutable(path); err != nil {
		return err
	}
	if _, err := update.CheckVersion(args[0]); err != nil {
		return err
	}
	binary, err := update.ResolveBinary(args[0])
	if err != nil {
		return err
	}
	return update.InstallVerified(args[1], path, binary.SHA)
}

func waitUpdatedDaemon(tag string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		pid, running, err := daemon.RuntimeStatus()
		if err == nil && running {
			state, err := daemon.ReadState()
			if err == nil && state.PID == pid {
				valid, err := daemon.VerifyRuntimeIdentity(pid, state.RuntimeInstanceToken)
				if err == nil && valid && sameReleaseVersion(state.Version, tag) {
					return nil
				}
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("installed %s, but could not verify the restarted daemon version within %s; run pocketctl daemon status", tag, timeout)
}

func sameReleaseVersion(a, b string) bool {
	return strings.TrimPrefix(a, "v") == strings.TrimPrefix(b, "v")
}
