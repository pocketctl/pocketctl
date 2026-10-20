package update

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ExecutablePath pins replacement to the executable actually invoked, never PATH.
func ExecutablePath() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(path)
}

// InstallVerified stages on the destination filesystem. All fallible copying,
// digest verification, ownership and mode changes happen before atomic rename.
// In a privileged helper, expectedSHA must be fetched independently from the
// official release source, not accepted from the unprivileged caller.
func InstallVerified(source, target, expectedSHA string) error {
	if _, err := parseDigest("sha256:" + expectedSHA); err != nil {
		return err
	}
	info, err := os.Lstat(target)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("installation target is not a regular file: %s", target)
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	srcInfo, err := in.Stat()
	if err != nil {
		return err
	}
	if !srcInfo.Mode().IsRegular() {
		return fmt.Errorf("update source is not a regular file")
	}
	staged, err := os.CreateTemp(filepath.Dir(target), ".pocketctl-update-*")
	if err != nil {
		return err
	}
	name := staged.Name()
	defer os.Remove(name)
	defer staged.Close()
	if _, err = io.Copy(staged, in); err != nil {
		return err
	}
	if err = staged.Sync(); err != nil {
		return err
	}
	if err = staged.Close(); err != nil {
		return err
	}
	sha, err := fileSHA256(name)
	if err != nil {
		return err
	}
	if !strings.EqualFold(sha, expectedSHA) {
		return fmt.Errorf("staged binary SHA256 mismatch")
	}
	if err = preserveInstallOwner(name, info); err != nil {
		return err
	}
	// Never propagate setuid/setgid bits to a downloaded executable.
	if err = os.Chmod(name, info.Mode().Perm()); err != nil {
		return err
	}
	resignDarwin(name)
	// Do not remove the old binary on failure: it must remain usable.
	return os.Rename(name, target)
}
