// Package update handles daemon self-update: version checking,
// binary download with SHA256 verification, and safe replacement.
package update

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/i18n"
)

const (
	githubAPI    = "https://api.github.com/repos/pocketctl/pocketctl/releases"
	githubDL     = "https://github.com/pocketctl/pocketctl/releases/download"
	defaultBin   = "pocketctl"
)

// CheckLatest queries the GitHub API for the latest release tag.
func CheckLatest() (tag string, err error) {
	url := githubAPI + "/latest"
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("query latest release: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GitHub API returned %s", resp.Status)
	}

	var rel struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return "", fmt.Errorf("decode response: %w", err)
	}
	if rel.TagName == "" {
		return "", fmt.Errorf("empty tag_name in response")
	}
	return rel.TagName, nil
}

// CheckVersion queries for a specific version's release and returns its tag.
func CheckVersion(version string) (tag string, err error) {
	// If version looks like v0.1.0, use it directly. Otherwise try API.
	if strings.HasPrefix(version, "v") {
		// Verify the tag exists by fetching the release
		url := fmt.Sprintf("%s/tags/%s", githubAPI, version)
		req, _ := http.NewRequest("GET", url, nil)
		req.Header.Set("Accept", "application/json")

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return "", fmt.Errorf("query version %s: %w", version, err)
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusNotFound {
			return "", fmt.Errorf("version %s not found on GitHub", version)
		}
		if resp.StatusCode != http.StatusOK {
			return "", fmt.Errorf("GitHub API returned %s", resp.Status)
		}
		return version, nil
	}
	return "", fmt.Errorf("version must start with 'v', got: %s", version)
}

// BinaryInfo describes a downloadable binary.
type BinaryInfo struct {
	OS   string
	Arch string
	URL  string
	SHA  string
	Name string // binary filename (e.g. pocketctl_darwin_arm64)
}

// ResolveBinary constructs the download URL and fetches the SHA256 checksum.
func ResolveBinary(tag string) (*BinaryInfo, error) {
	goos := runtime.GOOS
	goarch := runtime.GOARCH

	// Normalize arch names
	switch goarch {
	case "x86_64":
		goarch = "amd64"
	case "aarch64":
		goarch = "arm64"
	}

	name := fmt.Sprintf("pocketctl_%s_%s", goos, goarch)
	url := fmt.Sprintf("%s/%s/%s", githubDL, tag, name)

	// Fetch SHA256
	sha, err := fetchSHA256(url + ".sha256")
	if err != nil {
		return nil, fmt.Errorf("fetch checksum: %w", err)
	}

	return &BinaryInfo{
		OS:   goos,
		Arch: goarch,
		URL:  url,
		SHA:  sha,
		Name: name,
	}, nil
}

// DownloadAndVerify downloads the binary, verifies SHA256, and returns the temp path.
func DownloadAndVerify(info *BinaryInfo) (tmpPath string, err error) {
	tmpFile, err := os.CreateTemp("", "pocketctl-update-*")
	if err != nil {
		return "", fmt.Errorf("create temp file: %w", err)
	}
	tmpPath = tmpFile.Name()

	// Download
	resp, err := http.Get(info.URL)
	if err != nil {
		os.Remove(tmpPath)
		return "", fmt.Errorf("download %s: %w", info.URL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		os.Remove(tmpPath)
		return "", fmt.Errorf("download %s returned %s", info.URL, resp.Status)
	}

	written, err := io.Copy(tmpFile, resp.Body)
	if err != nil {
		tmpFile.Close()
		os.Remove(tmpPath)
		return "", fmt.Errorf("read response: %w", err)
	}
	tmpFile.Close()

	if written == 0 {
		os.Remove(tmpPath)
		return "", fmt.Errorf("downloaded file is empty")
	}

	// SHA256 verification
	if info.SHA != "" {
		actual, err := fileSHA256(tmpPath)
		if err != nil {
			os.Remove(tmpPath)
			return "", fmt.Errorf("compute SHA256: %w", err)
		}
		if !strings.EqualFold(actual, info.SHA) {
			os.Remove(tmpPath)
			return "", fmt.Errorf("SHA256 mismatch: expected %s, got %s", info.SHA, actual)
		}
	}

	// Make executable
	if err := os.Chmod(tmpPath, 0755); err != nil {
		os.Remove(tmpPath)
		return "", fmt.Errorf("chmod: %w", err)
	}

	return tmpPath, nil
}

// ReplaceBinary safely replaces the running binary with a new one at tmpPath.
// On success it removes the temp file and returns nil.
func ReplaceBinary(tmpPath string) error {
	execPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("get executable path: %w", err)
	}

	// Resolve symlinks to get the real path
	realPath, err := filepath.EvalSymlinks(execPath)
	if err != nil {
		realPath = execPath
	}

	info, err := os.Stat(realPath)
	if err != nil {
		return fmt.Errorf("stat %s: %w", realPath, err)
	}

	// Try direct rename first
	if err := os.Rename(tmpPath, realPath); err != nil {
		// If that fails (cross-device or permissions), try copy + remove
		if isCrossDevice(err) || os.IsPermission(err) {
			// Copy the new binary into place
			if err := copyFile(tmpPath, realPath, info.Mode()); err != nil {
				os.Remove(tmpPath)
				return fmt.Errorf("replace binary at %s: %w", realPath, err)
			}
			os.Remove(tmpPath)
		} else {
			os.Remove(tmpPath)
			return fmt.Errorf("rename %s -> %s: %w", tmpPath, realPath, err)
		}
	}

	return nil
}

// RestartDaemon restarts the daemon process (if running via systemd/launchd or direct exec).
// Returns the previous PID or 0 if not running.
func RestartDaemon() error {
	// Check if daemon is running
	if pid, running := isDaemonRunning(); running {
		fmt.Println(i18n.T("update.daemon_restarting", pid))

		// Kill the current daemon
		if err := killDaemon(pid); err != nil {
			return fmt.Errorf("stop daemon (PID %d): %w", pid, err)
		}

		// Wait for process to exit
		waitForExit(pid, 5)

		// Start daemon with stored config
		execPath, _ := os.Executable()
		cmd := exec.Command(execPath, "daemon", "start")
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr

		if err := cmd.Start(); err != nil {
			return fmt.Errorf("restart daemon: %w", err)
		}

		fmt.Println(i18n.T("update.daemon_restarted", cmd.Process.Pid))
	} else {
		fmt.Println(i18n.T("update.daemon_idle"))
	}

	return nil
}

// --- helpers ---

func fetchSHA256(url string) (string, error) {
	resp, err := http.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %s", resp.Status)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	return strings.TrimSpace(strings.Split(string(body), " ")[0]), nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", h.Sum(nil)), nil
}

func copyFile(src, dst string, mode os.FileMode) error {
	s, err := os.Open(src)
	if err != nil {
		return err
	}
	defer s.Close()

	d, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer d.Close()

	if _, err := io.Copy(d, s); err != nil {
		return err
	}
	return nil
}

func isCrossDevice(err error) bool {
	return strings.Contains(err.Error(), "invalid cross-device link")
}

func isDaemonRunning() (int, bool) {
	// Try reading PID file
	pidPath := "/tmp/pocketctl/daemon.pid"
	data, err := os.ReadFile(pidPath)
	if err != nil {
		return 0, false
	}

	var pid int
	if _, err := fmt.Sscanf(string(data), "%d", &pid); err != nil {
		return 0, false
	}

	// Check if process exists
	proc, err := os.FindProcess(pid)
	if err != nil {
		return 0, false
	}

	// On Unix, FindProcess always succeeds; send signal 0 to check alive
	if err := proc.Signal(os.Signal(nil)); err != nil {
		return 0, false
	}

	return pid, true
}

func killDaemon(pid int) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Signal(os.Interrupt)
}

func waitForExit(pid int, maxSeconds int) {
	for i := 0; i < maxSeconds; i++ {
		proc, err := os.FindProcess(pid)
		if err != nil || proc.Signal(os.Signal(nil)) != nil {
			return // process exited
		}
		timeSleep(1)
	}
	// Force kill if still running
	if proc, err := os.FindProcess(pid); err == nil {
		proc.Signal(os.Kill)
	}
}

// timeSleep exists so we can substitute in tests
var timeSleep = func(d int) {
	time.Sleep(time.Duration(d) * time.Second)
}
