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
	githubAPI = "https://api.github.com/repos/pocketctl/pocketctl/releases"
	githubDL  = "https://github.com/pocketctl/pocketctl/releases/download"

	defaultBin          = "pocketctl"
	maxDownloadRetries  = 3 // retry count per URL on transient download errors
)

// ghProxies is the ordered list of public GitHub acceleration proxies for
// users in mainland China. They mirror the full GitHub URL as a prefix.
//
// These are community-run and can go down at any time — we keep several and
// try them in sequence so a single proxy outage no longer blocks downloads.
// GitHub direct is always appended as the final fallback (see ResolveBinary).
// Last health check: 2026-06-26 (gh-proxy.com, ghfast.top, ghproxy.net OK;
// mirror.ghproxy.com and github.moeyy.xyz deprecated/removed).
var ghProxies = []string{
	"https://gh-proxy.com/",
	"https://ghfast.top/",
	"https://ghproxy.net/",
}

// apiClient has a short timeout so version checks won't hang when GitHub
// is unreachable.
var apiClient = &http.Client{Timeout: 10 * time.Second}

// downloadClient has a generous timeout for large binary downloads (~10–50 MB).
// Each attempt has its own deadline; the retry loop in downloadOne provides
// additional resilience for transient failures.
//
// Kept moderate (3 min, down from 10) so a hung proxy is abandoned fast enough
// to fall through to the next candidate URL in DownloadAndVerify.
var downloadClient = &http.Client{Timeout: 3 * time.Minute}

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
	// URL is the primary download URL (first source that returned a valid SHA).
	URL string
	// FallbackURLs are tried (in order) if URL fails to download or verify.
	// They are constructed so the SHA256 fetched from URL's source still
	// applies — all candidates below share the same binary bytes per release.
	FallbackURLs []string
	// SHA is the SHA256 checksum shared by every candidate URL (same release
	// asset mirrored across proxies, so a single checksum covers them all).
	SHA  string
	Name string // binary filename (e.g. pocketctl_darwin_arm64)
}

// ResolveBinary constructs the download URL and fetches the SHA256 checksum.
//
// It probes sources in order: each public acceleration proxy, then GitHub
// direct. The first source whose <url>.sha256 is fetchable becomes the primary
// URL; the remaining sources are appended as fallbacks. Because every source
// serves the identical release asset, the SHA256 from the primary source
// transitively validates downloads from any fallback.
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

	// Build the full ordered candidate list: each proxy prefix + the GitHub
	// direct URL as the final fallback. Deduplicate in case a proxy equals
	// the direct URL (defensive; keeps the list clean).
	candidates := make([]string, 0, len(ghProxies)+1)
	for _, p := range ghProxies {
		candidates = append(candidates, p+ghURL)
	}
	candidates = append(candidates, ghURL)

	// Find the first source that can provide a SHA256 checksum. That checksum
	// is valid for every candidate (identical bytes per release), so once we
	// have it we can offer all sources as download candidates.
	var sha string
	primaryIdx := -1
	for i, u := range candidates {
		s, err := fetchSHA256(u + ".sha256")
		if err == nil && s != "" {
			sha = s
			primaryIdx = i
			break
		}
	}
	if primaryIdx < 0 {
		return nil, fmt.Errorf("binary %s not found on any source (tag=%s)", name, tag)
	}

	// Primary URL first; the rest become fallbacks (same checksum applies).
	primary := candidates[primaryIdx]
	fallbacks := make([]string, 0, len(candidates)-1)
	for i, u := range candidates {
		if i == primaryIdx {
			continue
		}
		fallbacks = append(fallbacks, u)
	}

	return &BinaryInfo{
		OS:           goos,
		Arch:         goarch,
		URL:          primary,
		FallbackURLs: fallbacks,
		SHA:          sha,
		Name:         name,
	}, nil
}

// DownloadAndVerify downloads the binary, verifies SHA256, and returns the temp path.
//
// It tries info.URL first, then each entry in info.FallbackURLs. Retries up to
// maxDownloadRetries per URL on transient errors (unexpected EOF, connection
// reset, timeout) before moving to the next source. Permanent errors (SHA256
// mismatch, 404) abort immediately — retrying another source won't help for a
// checksum mismatch, and a 404 on one mirror usually means the asset genuinely
// doesn't exist.
func DownloadAndVerify(info *BinaryInfo) (tmpPath string, err error) {
	urls := append([]string{info.URL}, info.FallbackURLs...)

	var lastErr error
	for _, url := range urls {
		tmpPath, lastErr = downloadOne(url, info.SHA)
		if lastErr == nil {
			return tmpPath, nil
		}
		// Don't try another URL for permanent errors (SHA mismatch, 404, etc.)
		if isPermanent(lastErr) {
			return "", lastErr
		}
	}
	return "", lastErr
}

// downloadOne downloads from a single URL with retries on transient errors.
func downloadOne(url, expectedSHA string) (string, error) {
	var lastErr error
	for attempt := 0; attempt < maxDownloadRetries; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * time.Second) // backoff: 1s, 2s
		}

		tmpFile, err := os.CreateTemp("", "pocketctl-update-*")
		if err != nil {
			return "", fmt.Errorf("create temp file: %w", err)
		}
		tmpPath := tmpFile.Name()

		// Use a fresh client per attempt (no connection reuse across retries)
		resp, err := downloadClient.Get(url)
		if err != nil {
			tmpFile.Close()
			os.Remove(tmpPath)
			lastErr = fmt.Errorf("download %s: %w", url, err)
			continue
		}

		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			tmpFile.Close()
			os.Remove(tmpPath)
			lastErr = fmt.Errorf("download %s returned %s", url, resp.Status)
			// 404 / 410 are permanent — don't retry
			if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
				return "", lastErr
			}
			continue
		}

		// Stream through a progress bar so the user sees a live percentage
		// (Content-Length known) or a spinner + running byte count (chunked).
		bar := newProgressBar(resp.ContentLength)
		written, copyErr := io.Copy(tmpFile, &progressReader{r: resp.Body, bar: bar})
		bar.Done()
		resp.Body.Close()
		tmpFile.Close()

		if copyErr != nil {
			os.Remove(tmpPath)
			lastErr = fmt.Errorf("read response: %w", copyErr)
			continue // transient — retry
		}

		if written == 0 {
			os.Remove(tmpPath)
			lastErr = fmt.Errorf("downloaded file is empty")
			continue
		}

		// SHA256 verification
		if expectedSHA != "" {
			actual, err := fileSHA256(tmpPath)
			if err != nil {
				os.Remove(tmpPath)
				lastErr = fmt.Errorf("compute SHA256: %w", err)
				continue
			}
			if !strings.EqualFold(actual, expectedSHA) {
				os.Remove(tmpPath)
				return "", fmt.Errorf("SHA256 mismatch: expected %s, got %s", expectedSHA, actual)
			}
		}

		// Make executable
		if err := os.Chmod(tmpPath, 0755); err != nil {
			os.Remove(tmpPath)
			return "", fmt.Errorf("chmod: %w", err)
		}

		return tmpPath, nil
	}
	return "", lastErr
}

// isPermanent returns true for errors that won't be fixed by retrying another URL.
func isPermanent(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "SHA256 mismatch") ||
		strings.Contains(msg, "chmod") ||
		strings.Contains(msg, "create temp file") ||
		strings.Contains(msg, "compute SHA256")
}

// ReplaceBinary safely replaces the running binary with a new one at tmpPath.
// On success it removes the temp file and returns nil.
func ReplaceBinary(tmpPath string) (err error) {
	execPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("get executable path: %w", err)
	}

	// Resolve symlinks to get the real path
	realPath, err := filepath.EvalSymlinks(execPath)
	if err != nil {
		realPath = execPath
	}

	// On macOS, an ad-hoc/unsigned binary that re-execs itself (which the daemon
	// does on `daemon start` and `daemon_restart`) is SIGKILL'd by Gatekeeper
	// once its on-disk contents change. After we swap in the freshly downloaded
	// binary its prior signature is invalid, so re-sign it ad-hoc here — every
	// successful replacement path funnels through this deferred call.
	defer func() {
		if err == nil {
			resignDarwin(realPath)
		}
	}()

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
