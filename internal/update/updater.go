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
	// GitHub Release (global source for both API and download)
	githubAPI  = "https://api.github.com/repos/pocketctl/pocketctl/releases"
	githubDL   = "https://github.com/pocketctl/pocketctl/releases/download"

	// Domestic acceleration proxies for GitHub Release downloads.
	// Tried in order before falling back to direct GitHub.
	// ghproxy mirrors the full GitHub URL path — fast in China, no size limit.
	domesticProxies = "https://ghp.ci/"

	defaultBin = "pocketctl"
)

// apiClient has a short timeout so version checks won't hang when Gitee/GitHub
// is unreachable. Downloads use http.DefaultClient (no timeout — big files).
var apiClient = &http.Client{Timeout: 10 * time.Second}

// CheckLatest queries the GitHub releases API for the latest version tag.
func CheckLatest() (tag string, err error) {
	return queryLatest(githubAPI)
}

// queryLatest fetched the /latest release tag from a single API base URL.
func queryLatest(api string) (string, error) {
	req, _ := http.NewRequest("GET", api+"/latest", nil)
	req.Header.Set("Accept", "application/json")
	resp, err := apiClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s returned %s", api, resp.Status)
	}
	var rel struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return "", err
	}
	if rel.TagName == "" {
		return "", fmt.Errorf("empty tag_name in response from %s", api)
	}
	return rel.TagName, nil
}

// CheckVersion verifies a specific version tag exists on GitHub.
func CheckVersion(version string) (tag string, err error) {
	if !strings.HasPrefix(version, "v") {
		return "", fmt.Errorf("version must start with 'v', got: %s", version)
	}
	return queryVersionTag(githubAPI, version)
}

// queryVersionTag verifies a specific version tag exists on a single API base URL.
func queryVersionTag(api, version string) (string, error) {
	url := fmt.Sprintf("%s/tags/%s", api, version)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Accept", "application/json")
	resp, err := apiClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return "", fmt.Errorf("version %s not found on %s", version, api)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s returned %s", api, resp.Status)
	}
	return version, nil
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
// Tries domestic proxy (ghproxy) first for users in China, then falls back to
// direct GitHub.
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
	ghURL := fmt.Sprintf("%s/%s/%s", githubDL, tag, name)

	// Try domestic proxy first (fast in China), then direct GitHub.
	sources := []string{
		domesticProxies + ghURL, // ghproxy mirror
		ghURL,                    // direct GitHub
	}
	for _, url := range sources {
		sha, err := fetchSHA256(url + ".sha256")
		if err == nil && sha != "" {
			return &BinaryInfo{
				OS:   goos,
				Arch: goarch,
				URL:  url,
				SHA:  sha,
				Name: name,
			}, nil
		}
	}
	return nil, fmt.Errorf("binary %s not found on any source (tag=%s)", name, tag)
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

	// Try direct rename first (atomic, preferred on all platforms).
	if err := os.Rename(tmpPath, realPath); err != nil {
		errStr := err.Error()
		// "text file busy" (ETXTBSY) happens on Linux/WSL when the binary is
		// currently running — you can't rename over a live executable.
		// The standard workaround: delete the old file first (Linux keeps the
		// inode alive until the process exits, but the path is freed), then
		// rename the new one into place.
		if strings.Contains(errStr, "text file busy") || strings.Contains(errStr, "resource busy") || strings.Contains(errStr, "permission denied") {
			// Remove the old binary (safe on Linux: inode stays until process exits)
			if rmErr := os.Remove(realPath); rmErr == nil {
				// Now rename the new binary into the freed path
				if renameErr := os.Rename(tmpPath, realPath); renameErr == nil {
					return nil
				}
				// rename still failed — try copy to the freed path
				if copyErr := copyFile(tmpPath, realPath, info.Mode()); copyErr == nil {
					os.Remove(tmpPath)
					return nil
				}
			}
			// Remove didn't work either — fall through to retry/cross-device logic
		}
		// Retry for transient EBUSY on NTFS/DrvFs (/mnt/c on WSL)
		if strings.Contains(errStr, "text file busy") || strings.Contains(errStr, "resource busy") {
			for i := 0; i < 3; i++ {
				time.Sleep(500 * time.Millisecond)
				if err := os.Rename(tmpPath, realPath); err == nil {
					return nil
				}
			}
		}
		// If that fails (cross-device or permissions), try copy + remove
		if isCrossDevice(err) || os.IsPermission(err) {
			// On Linux, copying over a running binary also gets ETXTBSY.
			// Remove first, then copy (same trick as above).
			os.Remove(realPath)
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

	// On Linux/WSL, opening a running binary with O_WRONLY|O_TRUNC returns
	// ETXTBSY ("text file busy"). Retry a few times in case the OS releases
	// the lock momentarily.
	var d *os.File
	for i := 0; i < 3; i++ {
		d, err = os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
		if err == nil {
			break
		}
		if !strings.Contains(err.Error(), "text file busy") {
			break // different error, don't retry
		}
		time.Sleep(500 * time.Millisecond)
	}
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
