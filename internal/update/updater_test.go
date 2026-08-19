package update

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
)

const testHTTPTimeout = 5 * time.Second

func hexSHA(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// These tests pin the H-5 trust model: the community mirrors may only serve
// untrusted bytes; the accepted digest comes exclusively from the official
// GitHub release API (or, for legacy releases without digests, the official
// GitHub direct .sha256 sidecar — never a mirror sidecar).

type mirrorFixture struct {
	officialAPI   *httptest.Server
	officialDL    *httptest.Server
	mirror        *httptest.Server
	goodBinary    []byte
	evilBinary    []byte
	goodSHA       string // real SHA of goodBinary, served by official sources
	omitAPIDigest bool   // serve the asset without a digest field (legacy release)
	apiDigest     string // digest served by the official API
	apiAssetName  string // name served by the official API ("" = correct asset)
	dlSidecarSHA  string // digest served by the official direct sidecar ("" = 404)
	mirrorServes  string // "evil" | "good" | "fail"
	mirrorSidecar string // digest the mirror sidecar advertises
	apiStatus     int    // official API status (0 = 200)
	dlStatus      int    // official direct sidecar status (0 = 200)
}

func (f *mirrorFixture) install(t *testing.T) {
	t.Helper()

	f.goodBinary = []byte("good-pocketctl-binary-bytes")
	f.evilBinary = []byte("evil-pocketctl-binary-bytes")
	f.goodSHA = hexSHA(f.goodBinary)
	if !f.omitAPIDigest && f.apiDigest == "" && f.apiStatus == 0 {
		f.apiDigest = "sha256:" + f.goodSHA
	}
	if f.apiAssetName == "" {
		f.apiAssetName = "pocketctl_darwin_arm64"
	}
	if f.mirrorSidecar == "" {
		f.mirrorSidecar = strings.Repeat("e", 64)
	}

	assetName := "pocketctl_darwin_arm64"
	f.officialAPI = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f.apiStatus != 0 {
			w.WriteHeader(f.apiStatus)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		digestField := ""
		if f.apiDigest != "" {
			digestField = `,"digest":"` + f.apiDigest + `"`
		}
		_, _ = w.Write([]byte(`{"tag_name":"v1.0.0","assets":[{"name":"` + f.apiAssetName + `","size":` + strconv.Itoa(len(f.goodBinary)) + digestField + `}]}`))
	}))
	f.officialDL = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".sha256") {
			if f.dlStatus != 0 {
				w.WriteHeader(f.dlStatus)
				return
			}
			if f.dlSidecarSHA == "" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			sidecar := f.dlSidecarSHA
			if sidecar == "GOOD" {
				sidecar = f.goodSHA
			}
			_, _ = w.Write([]byte(sidecar + "  " + assetName + "\n"))
			return
		}
		_, _ = w.Write(f.goodBinary)
	}))
	f.mirror = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, ".sha256"):
			_, _ = w.Write([]byte(f.mirrorSidecar + "  " + assetName + "\n"))
		case f.mirrorServes == "evil":
			_, _ = w.Write(f.evilBinary)
		case f.mirrorServes == "good":
			_, _ = w.Write(f.goodBinary)
		default:
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	}))

	t.Cleanup(func() {
		f.officialAPI.Close()
		f.officialDL.Close()
		f.mirror.Close()
	})

	restoreAPI, restoreDL, restoreProxies, restoreAPIClient, restoreDownloadClient := githubAPIBase, githubDLBase, proxyPrefixes, apiClient, downloadClient
	t.Cleanup(func() {
		githubAPIBase = restoreAPI
		githubDLBase = restoreDL
		proxyPrefixes = restoreProxies
		apiClient = restoreAPIClient
		downloadClient = restoreDownloadClient
	})

	githubAPIBase = f.officialAPI.URL + "/repos/pocketctl/pocketctl/releases"
	githubDLBase = f.officialDL.URL + "/pocketctl/pocketctl/releases/download"
	proxyPrefixes = []string{f.mirror.URL + "/"}
	apiClient = &http.Client{Timeout: testHTTPTimeout}
	downloadClient = &http.Client{Timeout: testHTTPTimeout}
}

func goodTempBinary(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "pocketctl_darwin_arm64")
	if err := os.WriteFile(path, []byte("good-pocketctl-binary-bytes"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestResolveBinaryTrustingOfficialDigestOverMirrorSidecar(t *testing.T) {
	f := &mirrorFixture{mirrorServes: "good"}
	f.install(t)

	info, err := ResolveBinary("v1.0.0")
	if err != nil {
		t.Fatalf("ResolveBinary: %v", err)
	}
	if info.SHA != f.goodSHA {
		t.Fatalf("SHA must come from the official API digest, got %q", info.SHA)
	}
	if len(info.FallbackURLs) == 0 {
		t.Fatal("mirror must remain available as a binary candidate")
	}
}

func TestMaliciousMirrorCannotReplaceBinaryAndSidecar(t *testing.T) {
	// The mirror serves evil bytes plus a self-consistent evil sidecar; the
	// official API digest pins the good bytes. The evil download must be
	// rejected, and the official direct mirror must then succeed.
	f := &mirrorFixture{mirrorServes: "evil"}
	f.install(t)

	info, err := ResolveBinary("v1.0.0")
	if err != nil {
		t.Fatalf("ResolveBinary: %v", err)
	}
	if info.SHA != f.goodSHA {
		t.Fatalf("trusted digest changed to mirror value: %q", info.SHA)
	}

	tmp, err := DownloadAndVerify(info)
	if err != nil {
		t.Fatalf("DownloadAndVerify should fall through to the official mirror: %v", err)
	}
	defer os.Remove(tmp)
	got, err := os.ReadFile(tmp)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(f.goodBinary) {
		t.Fatal("downloaded binary is not the officially digested artifact")
	}
}

func TestResolveBinaryFailsClosedWithoutOfficialTrustRoot(t *testing.T) {
	// Official API and official direct sidecar both unavailable: the mirror's
	// checksum must never be promoted to a trust root.
	f := &mirrorFixture{mirrorServes: "good", apiStatus: http.StatusBadGateway, dlStatus: http.StatusBadGateway}
	f.install(t)

	_, err := ResolveBinary("v1.0.0")
	if err == nil {
		t.Fatal("ResolveBinary must fail closed when no official trust source is reachable")
	}
	if !strings.Contains(err.Error(), "official") {
		t.Fatalf("error must name the missing official chain: %v", err)
	}
}

func TestResolveBinaryRejectsMalformedOfficialDigest(t *testing.T) {
	f := &mirrorFixture{mirrorServes: "good", apiDigest: "sha256:abc123"}
	f.install(t)

	_, err := ResolveBinary("v1.0.0")
	if err == nil {
		t.Fatal("malformed official digest must be rejected")
	}
}

func TestResolveBinaryRejectsMissingExactAsset(t *testing.T) {
	// The API lists an unrelated asset and the official sidecar is absent.
	f := &mirrorFixture{mirrorServes: "good", apiAssetName: "pocketctl_windows_amd64.exe", dlSidecarSHA: ""}
	f.install(t)

	_, err := ResolveBinary("v1.0.0")
	if err == nil {
		t.Fatal("release without the exact platform asset must fail closed")
	}
}

func TestResolveBinaryLegacyReleaseUsesOfficialDirectSidecar(t *testing.T) {
	// Old releases have no API digest: the only permitted fallback is the
	// official GitHub-direct .sha256 — mirror sidecars stay ignored.
	f := &mirrorFixture{mirrorServes: "good", omitAPIDigest: true, dlSidecarSHA: "GOOD"}
	f.install(t)

	info, err := ResolveBinary("v1.0.0")
	if err != nil {
		t.Fatalf("ResolveBinary legacy fallback: %v", err)
	}
	if info.SHA != f.goodSHA {
		t.Fatalf("legacy digest must come from the official sidecar, got %q", info.SHA)
	}
}

func TestDownloadMismatchContinuesToNextMirror(t *testing.T) {
	// First candidate serves a mismatching binary; the second candidate is
	// good. A single poisoned mirror must not block safe fallbacks.
	f := &mirrorFixture{mirrorServes: "evil"}
	f.install(t)
	goodPath := goodTempBinary(t)

	evilServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".sha256") {
			_, _ = w.Write([]byte(strings.Repeat("e", 64) + "\n"))
			return
		}
		_, _ = w.Write([]byte("evil"))
	}))
	defer evilServer.Close()
	goodServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, goodPath)
	}))
	defer goodServer.Close()

	info := &BinaryInfo{
		URL:          evilServer.URL + "/pocketctl_darwin_arm64",
		FallbackURLs: []string{goodServer.URL + "/pocketctl_darwin_arm64"},
		SHA:          fileSHAOf(t, goodPath),
	}
	tmp, err := DownloadAndVerify(info)
	if err != nil {
		t.Fatalf("mismatch on the first mirror must not abort the chain: %v", err)
	}
	defer os.Remove(tmp)
}

func fileSHAOf(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return hexSHA(data)
}

// --- H-6: restart must reuse the daemon's verified lifecycle authority ---

type fakeDaemonController struct {
	statusPID     int
	statusRunning bool
	statusErr     error
	stopCalls     int
	stopErr       error
}

func (f *fakeDaemonController) RuntimeStatus() (int, bool, error) {
	return f.statusPID, f.statusRunning, f.statusErr
}

func (f *fakeDaemonController) Stop() error {
	f.stopCalls++
	return f.stopErr
}

func withFakeDaemonController(t *testing.T, fake *fakeDaemonController) (started *bool) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	if err := config.SaveDaemonSecurityPolicy(config.DaemonSecurityPolicy{TrustedActionPolicy: "off"}); err != nil {
		t.Fatalf("SaveDaemonSecurityPolicy: %v", err)
	}
	restoreController, restoreStart := daemonProcesses, startDaemonAfterUpdate
	started = new(bool)
	daemonProcesses = fake
	startDaemonAfterUpdate = func(_ []string) (int, error) {
		*started = true
		return 9999, nil
	}
	t.Cleanup(func() {
		daemonProcesses = restoreController
		startDaemonAfterUpdate = restoreStart
	})
	return started
}

func TestRestartDaemonAbortsOnUncertainStatus(t *testing.T) {
	fake := &fakeDaemonController{statusErr: errors.New("unverifiable")}
	started := withFakeDaemonController(t, fake)

	if err := RestartDaemon(); err == nil {
		t.Fatal("RestartDaemon must abort when runtime status is uncertain")
	}
	if fake.stopCalls != 0 || *started {
		t.Fatal("uncertain status must not stop or start any process")
	}
}

func TestRestartDaemonRequiresPersistedSecurityPolicyBeforeStopping(t *testing.T) {
	fake := &fakeDaemonController{statusPID: 4242, statusRunning: true}
	started := withFakeDaemonController(t, fake)
	path, err := config.DaemonSecurityPolicyPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}

	err = RestartDaemon()
	if err == nil || !strings.Contains(err.Error(), "security policy") {
		t.Fatalf("RestartDaemon error=%v want persisted security policy failure", err)
	}
	if fake.stopCalls != 0 || *started {
		t.Fatal("missing security policy must abort before stopping or starting the daemon")
	}
}

func TestRestartDaemonRestoresPersistedSecurityPolicyArguments(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	rootA := filepath.Join(home, "workspace-long-a")
	rootB := filepath.Join(home, "b")
	for _, root := range []string{rootA, rootB} {
		if err := os.MkdirAll(root, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	canonicalA, err := filepath.EvalSymlinks(rootA)
	if err != nil {
		t.Fatal(err)
	}
	canonicalB, err := filepath.EvalSymlinks(rootB)
	if err != nil {
		t.Fatal(err)
	}
	policyPath, err := config.DaemonSecurityPolicyPath()
	if err != nil {
		t.Fatal(err)
	}
	policyJSON, err := json.Marshal(map[string]any{
		"version":                            1,
		"allowed_cwd_roots":                  []string{canonicalA, canonicalB},
		"allow_dangerous_remote_permissions": true,
		"trusted_action_policy":              "on",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(policyPath, policyJSON, 0o600); err != nil {
		t.Fatal(err)
	}

	fake := &fakeDaemonController{statusPID: 4242, statusRunning: true}
	restoreController, restoreStart := daemonProcesses, startDaemonAfterUpdate
	daemonProcesses = fake
	var gotArgs []string
	startDaemonAfterUpdate = func(args []string) (int, error) {
		gotArgs = append([]string(nil), args...)
		return 9999, nil
	}
	t.Cleanup(func() {
		daemonProcesses = restoreController
		startDaemonAfterUpdate = restoreStart
	})

	if err := RestartDaemon(); err != nil {
		t.Fatalf("RestartDaemon: %v", err)
	}
	want := []string{
		"daemon", "start",
		"--allowed-cwd-root", canonicalA,
		"--allowed-cwd-root", canonicalB,
		"--allow-dangerous-remote-permissions",
		"--trusted-action-policy", "on",
	}
	if !reflect.DeepEqual(gotArgs, want) {
		t.Fatalf("restart argv=%q want %q", gotArgs, want)
	}
}

func TestRestartDaemonVerifiesBeforeStopAndStart(t *testing.T) {
	fake := &fakeDaemonController{statusPID: 4242, statusRunning: true}
	started := withFakeDaemonController(t, fake)

	if err := RestartDaemon(); err != nil {
		t.Fatalf("RestartDaemon: %v", err)
	}
	if fake.stopCalls != 1 {
		t.Fatalf("verified running daemon must be stopped exactly once, got %d", fake.stopCalls)
	}
	if !*started {
		t.Fatal("daemon must be started again after a safe stop")
	}
}

func TestRestartDaemonSkipsIdleDaemon(t *testing.T) {
	fake := &fakeDaemonController{statusPID: 0, statusRunning: false}
	started := withFakeDaemonController(t, fake)

	if err := RestartDaemon(); err != nil {
		t.Fatalf("RestartDaemon: %v", err)
	}
	if fake.stopCalls != 0 || *started {
		t.Fatal("idle daemon must not be stopped or started")
	}
}

func TestRestartDaemonDoesNotStartWhenSafeStopFails(t *testing.T) {
	fake := &fakeDaemonController{statusPID: 4242, statusRunning: true, stopErr: errors.New("identity changed mid-stop")}
	started := withFakeDaemonController(t, fake)

	if err := RestartDaemon(); err == nil {
		t.Fatal("RestartDaemon must fail when the safe stop fails")
	}
	if *started {
		t.Fatal("no new daemon may start when the old one was not safely stopped")
	}
}
