//go:build !windows

package session

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Observe the real resume reply to distinguish a preserved per-thread sandbox
// from an upstream switch to the current home configuration.
type adoptionPermissionCapture struct {
	codexRuntimeClient
	result chan codexNativeConfigFields
}

func (c adoptionPermissionCapture) Call(ctx context.Context, method string, params, result any) error {
	err := c.codexRuntimeClient.Call(ctx, method, params, result)
	if err == nil && method == "thread/resume" {
		var fields codexNativeConfigFields
		data, err := json.Marshal(result)
		if err == nil && json.Unmarshal(data, &fields) == nil {
			select {
			case c.result <- fields:
			default:
			}
		}
	}
	return err
}

// Exercise the public manager API with an independent native writer, no
// credentials, a private Codex home and a loopback-only Responses provider.
func TestInstalledNativeCodexAdoption(t *testing.T) {
	cli := os.Getenv("POCKETCTL_CODEX_ADOPTION_SMOKE_BINARY")
	if cli == "" {
		t.Skip("set POCKETCTL_CODEX_ADOPTION_SMOKE_BINARY to a real Codex CLI")
	}
	for _, pair := range os.Environ() {
		key, _, _ := strings.Cut(pair, "=")
		if strings.HasPrefix(key, "CODEX_") || strings.HasPrefix(key, "OPENAI_") || strings.HasPrefix(key, "POCKETCTL_") {
			t.Setenv(key, "")
		}
	}
	t.Setenv("HOME", t.TempDir())
	home := t.TempDir()
	work := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	t.Setenv("POCKETCTL_CODEX_RUNTIME_DIR", shortCodexRuntimeDir(t))
	ctx, cancel := context.WithTimeout(context.Background(), 160*time.Second)
	defer cancel()

	const first = "NATIVE_ADOPTION_FIRST_MESSAGE"
	const next = "ADOPTED_THREAD_SECOND_MESSAGE"
	entered, release := make(chan struct{}), make(chan struct{})
	signal := sync.OnceFunc(func() { close(entered) })
	releaseModel := sync.OnceFunc(func() { close(release) })
	both := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil || !strings.HasSuffix(r.URL.Path, "/responses") {
			http.NotFound(w, r)
			return
		}
		if bytes.Contains(body, []byte(first)) {
			signal()
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			if bytes.Contains(body, []byte(next)) {
				select {
				case both <- struct{}{}:
				default:
				}
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		item := map[string]any{"id": "msg_fixture", "type": "message", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": "fixture complete"}}}
		for _, evt := range []map[string]any{
			{"type": "response.created", "response": map[string]any{"id": "resp_fixture", "status": "in_progress"}},
			{"type": "response.output_item.done", "output_index": 0, "item": item},
			{"type": "response.completed", "response": map[string]any{"id": "resp_fixture", "status": "completed", "output": []any{item}}},
		} {
			data, _ := json.Marshal(evt)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", evt["type"], data)
		}
	}))
	defer srv.Close()
	defer releaseModel()
	catalog, err := filepath.Abs("../../scripts/verification/codex-docker/models.json")
	if err != nil {
		t.Fatal(err)
	}
	settings := fmt.Sprintf("model_provider = %q\nmodel = %q\nmodel_catalog_json = %q\napproval_policy = %q\nsandbox_mode = %q\n[model_providers.fixture]\nname = %q\nbase_url = %q\nwire_api = %q\nrequires_openai_auth = false\n", "fixture", "fixture", catalog, "on-request", "read-only", "Loopback", srv.URL+"/v1", "responses")
	settings += fmt.Sprintf("\n[projects.%q]\ntrust_level = %q\n", work, "trusted")
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(settings), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := agentcontrol.DefaultConfig()
	cfg.Codex.State = agentcontrol.StateEnabled
	cfg.Codex.RealBinary = cli
	if err := agentcontrol.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	newManager := func() *SessionManager {
		sm := NewSessionManager(make(chan protocol.DaemonEvent, 4096))
		sm.CodexRuntimeProvider().probe = (agentcontrol.CodexProbe{Timeout: 20 * time.Second}).Probe
		allowCwdForTest(t, sm)
		sm.SetRemotePermissionPolicy(adapter.RemotePermissionPolicy{AllowDangerous: true}) // exec selects never by default
		t.Cleanup(func() { sm.ShutdownCodex() })
		return sm
	}
	sm := newManager()
	cmd := exec.CommandContext(ctx, cli, "exec", "--skip-git-repo-check", "--json", first)
	cmd.Dir = work
	var terminal bytes.Buffer
	cmd.Stdout = &terminal
	cmd.Stderr = &terminal
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-entered:
	case err := <-done:
		t.Fatalf("native exited: %v %s", err, &terminal)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	files, err := filepath.Glob(filepath.Join(home, "sessions", "*", "*", "*", "*.jsonl"))
	if err != nil || len(files) != 1 {
		t.Fatalf("rollouts: %v %v", files, err)
	}
	meta, ok := adapter.ReadCodexRolloutMetadata(files[0])
	if !ok {
		t.Fatal("no native session_meta")
	}
	id := meta.ID
	start := func(request string, ms int64) protocol.AdoptionReceipt {
		r, err := sm.AdoptCodex(ctx, protocol.AdoptionRequest{SessionID: id, RequestID: request, WaitMS: ms})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	wait := func(r protocol.AdoptionReceipt, phase string) protocol.AdoptionReceipt {
		t.Helper()
		for {
			current, err := sm.CodexAdoptionStatus(ctx, id, r.OperationID)
			if err != nil {
				t.Fatal(err)
			}
			if current.Phase == phase {
				return current
			}
			if !adoptionActive(current.Phase) {
				t.Fatalf("want %s, got %+v", phase, current)
			}
			select {
			case <-time.After(30 * time.Millisecond):
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
	blocked := wait(start("probe", 0), "blocked")
	if blocked.Reason != "active_writer" {
		t.Fatalf("native writer evidence: %+v", blocked)
	}
	waiting := wait(start("wait-cancel", 60000), "waiting")
	cancelled, err := sm.CancelCodexAdoption(ctx, id, waiting.OperationID)
	if err != nil || cancelled.Phase != "cancelled" {
		t.Fatalf("cancel: %+v %v", cancelled, err)
	}
	waiting = wait(start("wait-release", 60000), "waiting")
	joined := start("other-client", 0)
	if joined.OperationID != waiting.OperationID {
		t.Fatal("cross-client request did not join")
	}
	releaseModel()
	if err := <-done; err != nil {
		t.Fatalf("native writer: %v %s", err, &terminal)
	}
	managed := wait(waiting, "managed")
	if !managed.LocalManaged || managed.RemoteReady || managed.ArchiveChanged {
		t.Fatalf("receipt %+v", managed)
	}
	turnCount := func() int {
		data, err := os.ReadFile(files[0])
		if err != nil {
			t.Fatal(err)
		}
		return bytes.Count(data, []byte(`"type":"task_complete"`))
	}
	if n := turnCount(); n != 1 {
		t.Fatalf("adoption generated a turn: %d", n)
	}
	if err := sm.SendMessage(ctx, id, next); err != nil {
		t.Fatal(err)
	}
	select {
	case <-both:
	case <-ctx.Done():
		t.Fatal("model missing prior history")
	}
	for turnCount() != 2 {
		select {
		case <-time.After(30 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal("second native turn incomplete")
		}
	}
	// A second native history is archived by the source app. Ordinary adoption
	// returns consent-required and leaves it archived. Explicit consent moves
	// exactly this rollout back and binds its original ID.
	archiveCmd := exec.CommandContext(ctx, cli, "exec", "--skip-git-repo-check", "--json", "NATIVE_ARCHIVE_MARKER")
	archiveCmd.Dir = work
	if out, err := archiveCmd.CombinedOutput(); err != nil {
		t.Fatalf("native seed: %v %s", err, out)
	}
	otherFiles, _ := filepath.Glob(filepath.Join(home, "sessions", "*", "*", "*", "*.jsonl"))
	var archiveID, archivePath string
	for _, file := range otherFiles {
		m, ok := adapter.ReadCodexRolloutMetadata(file)
		if ok && m.ID != id {
			archiveID, archivePath = m.ID, file
		}
	}
	if archiveID == "" {
		t.Fatal("second native history absent")
	}
	seedData, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	limit := lastAdoptionSandbox(ctx, bytes.NewReader(seedData))
	if limit == nil || limit.Sandbox.Type != "read-only" || limit.Approval == "" {
		t.Fatal("archived fixture lacks original read-only permissions")
	}
	c, _, ok := sm.CodexRuntimeProvider().coordinator.backendClient()
	if !ok {
		t.Fatal("no managed runtime")
	}
	if err := c.Call(ctx, "thread/archive", map[string]string{"threadId": archiveID}, nil); err != nil {
		t.Fatal(err)
	}
	q, err := sm.AdoptCodex(ctx, protocol.AdoptionRequest{SessionID: archiveID, RequestID: "ordinary-archive"})
	if err != nil {
		t.Fatal(err)
	}
	q = awaitAdoption(t, sm, archiveID, q.OperationID, "blocked")
	if q.Reason != "archived" || q.ArchiveChanged {
		t.Fatalf("archive consent %+v", q)
	}
	// The home configuration is now broader than the original history. Compare
	// the actual native reply with the original permission and public receipt.
	if err := sm.ShutdownCodex(); err != nil {
		t.Fatal(err)
	}
	widened := strings.Replace(settings, `sandbox_mode = "read-only"`, `sandbox_mode = "danger-full-access"`, 1)
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(widened), 0600); err != nil {
		t.Fatal(err)
	}
	sm = newManager() // the native process loads the new home configuration at startup
	reported := make(chan codexNativeConfigFields, 1)
	coord := sm.CodexRuntimeProvider().coordinator
	startNative := coord.start
	coord.start = func(ctx context.Context, binary, version string, generation uint64) (*codexAppServerRuntime, error) {
		rt, err := startNative(ctx, binary, version, generation)
		if err == nil {
			rt.Client = adoptionPermissionCapture{rt.Client, reported}
		}
		return rt, err
	}
	q, err = sm.AdoptCodex(ctx, protocol.AdoptionRequest{SessionID: archiveID, RequestID: "consent", Unarchive: true})
	if err != nil {
		t.Fatal(err)
	}
	q = awaitAdoption(t, sm, archiveID, q.OperationID, "managed", "blocked")
	var resumed codexNativeConfigFields
	select {
	case resumed = <-reported:
	case <-ctx.Done():
		t.Fatal("missing real resume permission")
	}
	actual := adoptedNativePermission(resumed)
	if actual == nil || !q.ArchiveChanged {
		t.Fatalf("incomplete archive evidence: %+v", q)
	}
	preserved := actual.SandboxMode == "read-only" && !resumed.Sandbox.NetworkAccess && (actual.ApprovalPolicy == limit.Approval || actual.ApprovalPolicy == "on-request" && limit.Approval == "never")
	if preserved {
		if !q.LocalManaged || q.Reason != "managed" {
			t.Fatalf("preserved native permission: %+v", q)
		}
	} else if q.LocalManaged || q.Reason != "permission_denied" {
		t.Fatalf("widened native permission: %+v", q)
	}
	postData, err := os.ReadFile(archivePath)
	if err != nil || bytes.Count(seedData, []byte(`"type":"task_complete"`)) != 1 || bytes.Count(postData, []byte(`"type":"task_complete"`)) != 1 {
		t.Fatal("archive permission check changed the turn count", err)
	}
	t.Logf("archive %s, original %s/%s, returned %s/%s, reason %s, one completed turn", archiveID, limit.Sandbox.Type, limit.Approval, actual.SandboxMode, actual.ApprovalPolicy, q.Reason)
	if err := sm.ShutdownCodex(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(settings), 0600); err != nil {
		t.Fatal(err)
	}
	sm = newManager()
	q, err = sm.AdoptCodex(ctx, protocol.AdoptionRequest{SessionID: archiveID, RequestID: "restored-sandbox"})
	if err != nil {
		t.Fatal(err)
	}
	q = awaitAdoption(t, sm, archiveID, q.OperationID, "managed")
	if q.ArchiveChanged || !q.LocalManaged {
		t.Fatalf("retry receipt %+v", q)
	}
	// Recover the public operations through a fresh manager and a fresh native
	// client. Recovery publishes no new turn and preserves operation identity.
	if err := sm.ShutdownCodex(); err != nil {
		t.Fatal(err)
	}
	restarted := newManager()
	if err := restarted.CodexRuntimeProvider().Recover(ctx); err != nil {
		t.Fatal(err)
	}
	restored := awaitAdoption(t, restarted, id, managed.OperationID, "managed")
	if restored.Revision <= managed.Revision || turnCount() != 2 {
		t.Fatalf("restart %+v", restored)
	}
	t.Logf("same thread %s, operation %s, revision %d, original rollout contains two completed turns", id, managed.OperationID, managed.Revision)
}
