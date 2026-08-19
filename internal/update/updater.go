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
	"slices"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/i18n"
	"github.com/pocketctl/pocketctl/internal/session"
)

const (
	// GitHub Release (global source for both API and download)
	githubAPI = "https://api.github.com/repos/pocketctl/pocketctl/releases"
	githubDL  = "https://github.com/pocketctl/pocketctl/releases/download"

	defaultBin          = "pocketctl"
	maxDownloadRetries  = 3 // retry count per URL on transient download errors
	maxChecksumBodySize = 1 << 10
)

// Base URLs and mirror prefixes are package variables so tests can point them
// at local fixtures. Only these holders are mutable — the trust rule is not:
// digests are accepted exclusively from the official GitHub API or the
// official GitHub-direct .sha256 sidecar; mirror sidecars are never trusted.
var (
	githubAPIBase = githubAPI
	githubDLBase  = githubDL
	proxyPrefixes = ghProxies
)

// ghProxies is the ordered list of public GitHub acceleration proxies for
// users in mainland China. They mirror the full GitHub URL as a prefix.
//
// These are community-run and untrusted: they may serve arbitrary bytes for
// both the binary and any .sha256 sidecar, so they are only ever used as
// download candidates whose bytes are checked against the official digest.
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
	return queryLatest(githubAPIBase)
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

// CheckVersion verifies a specific version tag exists on GitHub and that the
// release carries a verifiable official checksum for this platform's asset.
func CheckVersion(version string) (tag string, err error) {
	if !strings.HasPrefix(version, "v") {
		return "", fmt.Errorf("version must start with 'v', got: %s", version)
	}
	if err := queryVersionTagStatus(githubAPIBase, version); err != nil {
		return "", err
	}
	if _, _, err := resolveOfficialChecksum(version, platformAssetName()); err != nil {
		return "", err
	}
	return version, nil
}

// queryVersionTagStatus confirms a tag exists on the official release API.
func queryVersionTagStatus(api, version string) error {
	url := fmt.Sprintf("%s/tags/%s", api, version)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Accept", "application/json")
	resp, err := apiClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("version %s not found on %s", version, api)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s returned %s", api, resp.Status)
	}
	return nil
}

// BinaryInfo describes a downloadable binary.
type BinaryInfo struct {
	OS   string
	Arch string
	// URL is the primary download candidate.
	URL string
	// FallbackURLs are tried (in order) if URL fails to download or verify.
	FallbackURLs []string
	// SHA is the official SHA256 checksum. It comes from the GitHub release
	// API asset digest (or, for legacy releases without digests, the official
	// GitHub-direct .sha256 sidecar) — never from a mirror.
	SHA string
	// Size is the official asset size in bytes (0 = unknown, legacy fallback).
	Size int64
	Name string // binary filename (e.g. pocketctl_darwin_arm64)
}

func platformAssetName() string {
	goos := runtime.GOOS
	goarch := runtime.GOARCH
	switch goarch {
	case "x86_64":
		goarch = "amd64"
	case "aarch64":
		goarch = "arm64"
	}
	return fmt.Sprintf("pocketctl_%s_%s", goos, goarch)
}

type officialAsset struct {
	Name   string `json:"name"`
	Digest string `json:"digest"`
	Size   int64  `json:"size"`
}

// resolveOfficialChecksum obtains the trusted digest for one asset:
// first from the official GitHub release API metadata, then — only for legacy
// releases that predate asset digests — from the official GitHub-direct
// .sha256 sidecar. Mirror-sidecar fallbacks are structurally impossible here.
func resolveOfficialChecksum(tag, assetName string) (shaHex string, size int64, err error) {
	url := fmt.Sprintf("%s/tags/%s", githubAPIBase, tag)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := apiClient.Do(req)
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			var rel struct {
				Assets []officialAsset `json:"assets"`
			}
			if jsonErr := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&rel); jsonErr == nil {
				for _, a := range rel.Assets {
					if a.Name != assetName {
						continue
					}
					if a.Digest != "" {
						hex, digestErr := parseDigest(a.Digest)
						if digestErr != nil {
							return "", 0, digestErr
						}
						if a.Size <= 0 {
							return "", 0, fmt.Errorf("official asset %s has invalid size %d", assetName, a.Size)
						}
						return hex, a.Size, nil
					}
					break // exact asset found but no digest: legacy release
				}
			}
		}
	}

	// Legacy path: only the official GitHub-direct sidecar may establish trust.
	sidecarURL := fmt.Sprintf("%s/%s/%s.sha256", githubDLBase, tag, assetName)
	hex, sidecarErr := fetchSHA256(sidecarURL)
	if sidecarErr != nil {
		return "", 0, fmt.Errorf("cannot establish a trusted checksum chain: official release metadata and direct sidecar unavailable for %s (%v / %v)", assetName, err, sidecarErr)
	}
	return hex, 0, nil
}

// parseDigest validates a GitHub asset digest of the form sha256:<64 hex>.
func parseDigest(digest string) (string, error) {
	prefix := "sha256:"
	if !strings.HasPrefix(digest, prefix) {
		return "", fmt.Errorf("official digest must be sha256:<64 hex>, got %q", digest)
	}
	hex := strings.TrimPrefix(digest, prefix)
	if len(hex) != 64 {
		return "", fmt.Errorf("official digest must be sha256:<64 hex>, got %q", digest)
	}
	for _, c := range hex {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return "", fmt.Errorf("official digest contains non-hex characters: %q", digest)
		}
	}
	return hex, nil
}

// ResolveBinary builds the ordered download candidate list and pins the
// official checksum the bytes must match, regardless of which candidate
// serves them. Mirrors only ever contribute URLs, never trust.
func ResolveBinary(tag string) (*BinaryInfo, error) {
	name := platformAssetName()
	ghURL := fmt.Sprintf("%s/%s/%s", githubDLBase, tag, name)

	sha, size, err := resolveOfficialChecksum(tag, name)
	if err != nil {
		return nil, err
	}

	candidates := make([]string, 0, len(proxyPrefixes)+1)
	for _, p := range proxyPrefixes {
		candidates = append(candidates, p+ghURL)
	}
	candidates = append(candidates, ghURL)

	return &BinaryInfo{
		OS:           runtime.GOOS,
		Arch:         runtime.GOARCH,
		URL:          candidates[0],
		FallbackURLs: candidates[1:],
		SHA:          sha,
		Size:         size,
		Name:         name,
	}, nil
}

// DownloadAndVerify downloads the binary, verifies the official SHA256 and
// size, and returns the temp path. Every candidate is validated against the
// same official digest; a mismatch (e.g. a poisoned mirror) only eliminates
// that candidate and the chain continues to the next mirror.
func DownloadAndVerify(info *BinaryInfo) (tmpPath string, err error) {
	urls := append([]string{info.URL}, info.FallbackURLs...)

	var lastErr error
	for _, url := range urls {
		tmpPath, lastErr = downloadOne(url, info.SHA, info.Size)
		if lastErr == nil {
			return tmpPath, nil
		}
		// All errors, including digest mismatches and 404s, only eliminate
		// the current candidate; safe mirrors later in the chain may still
		// serve the officially digested bytes.
	}
	return "", lastErr
}

// downloadOne downloads from a single URL with retries on transient errors.
// A digest or size mismatch eliminates this candidate immediately (no retry);
// the caller continues with the next mirror.
func downloadOne(url, expectedSHA string, expectedSize int64) (string, error) {
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
			// 404 / 410 eliminate this candidate — don't retry it, let the
			// caller fall through to the next mirror.
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

		// Official size check (skipped for legacy sidecar-only releases).
		if expectedSize > 0 && written != expectedSize {
			os.Remove(tmpPath)
			return "", fmt.Errorf("size mismatch for %s: official %d bytes, got %d", url, expectedSize, written)
		}

		// SHA256 verification against the official digest — always required.
		if expectedSHA == "" {
			os.Remove(tmpPath)
			return "", fmt.Errorf("no official checksum available for %s", url)
		}
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

		// Make executable
		if err := os.Chmod(tmpPath, 0755); err != nil {
			os.Remove(tmpPath)
			return "", fmt.Errorf("chmod: %w", err)
		}

		return tmpPath, nil
	}
	return "", lastErr
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

// DaemonProcessController is the authoritative daemon lifecycle surface the
// updater must reuse. The daemon package's implementation verifies the PID
// file against the singleton lock's owner token and process-start identity;
// the updater never signals a PID it merely read from disk.
type DaemonProcessController interface {
	RuntimeStatus() (pid int, running bool, err error)
	Stop() error
}

type daemonProcessAdapter struct {
	status func() (int, bool, error)
	stop   func() error
}

func (a daemonProcessAdapter) RuntimeStatus() (int, bool, error) { return a.status() }
func (a daemonProcessAdapter) Stop() error                       { return a.stop() }

// daemonProcesses is swappable for tests.
var daemonProcesses DaemonProcessController = daemonProcessAdapter{
	status: daemon.RuntimeStatus,
	stop:   daemon.Stop,
}

// startDaemonAfterUpdate is swappable for tests.
var startDaemonAfterUpdate = func(args []string) (int, error) {
	execPath, err := os.Executable()
	if err != nil {
		return 0, err
	}
	cmd := exec.Command(execPath, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	return cmd.Process.Pid, nil
}

// RestartDaemon restarts the daemon only after the daemon package's verified
// lifecycle authority confirms it was running and has been safely stopped.
// Any uncertain status aborts the restart without signaling anything.
func RestartDaemon() error {
	pid, running, err := daemonProcesses.RuntimeStatus()
	if err != nil {
		return fmt.Errorf("abort daemon restart, runtime status uncertain: %w", err)
	}
	if !running {
		fmt.Println(i18n.T("update.daemon_idle"))
		return nil
	}
	policy, err := config.LoadDaemonSecurityPolicy()
	if err != nil {
		return fmt.Errorf("abort daemon restart, load security policy: %w", err)
	}
	validatedPolicy, err := session.NewCwdPolicy(policy.AllowedCwdRoots)
	if err != nil {
		return fmt.Errorf("abort daemon restart, validate security policy: %w", err)
	}
	if !slices.Equal(validatedPolicy.Roots(), policy.AllowedCwdRoots) {
		return fmt.Errorf("abort daemon restart, persisted security policy is not canonical")
	}
	restartArgs := []string{"daemon", "start"}
	for _, root := range policy.AllowedCwdRoots {
		restartArgs = append(restartArgs, "--allowed-cwd-root", root)
	}
	if policy.AllowDangerousRemotePermissions {
		restartArgs = append(restartArgs, "--allow-dangerous-remote-permissions")
	}
	restartArgs = append(restartArgs, "--trusted-action-policy", policy.TrustedActionPolicy)

	fmt.Println(i18n.T("update.daemon_restarting", pid))
	if err := daemonProcesses.Stop(); err != nil {
		return fmt.Errorf("stop daemon before restart (PID %d): %w", pid, err)
	}

	newPid, err := startDaemonAfterUpdate(restartArgs)
	if err != nil {
		return fmt.Errorf("restart daemon: %w", err)
	}
	fmt.Println(i18n.T("update.daemon_restarted", newPid))
	return nil
}

// --- helpers ---

// fetchSHA256 fetches a checksum sidecar from an official GitHub-direct URL
// with a bounded, status-checked, timeout-guarded client.
func fetchSHA256(url string) (string, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return "", err
	}
	resp, err := apiClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %s", resp.Status)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxChecksumBodySize))
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

// (isDaemonRunning/killDaemon/waitForExit PID-trust helpers were removed in H-6.)
