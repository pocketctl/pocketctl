package adapter

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/platform"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// opencode_serve.go hosts a single long-running `opencode serve` process and a
// thin HTTP/SSE client for it. opencode is a client/server agent: sessions are
// created and driven over REST and observed over a single SSE event bus. One
// OpencodeServer is shared by all opencode owned sessions (see design Decision 5).
//
// Transport only — the Part→DaemonEvent mapping lives in opencode.go. The
// caller passes the resolved CLI path (this package must not import discovery,
// which now imports adapter).
//
// Experiment findings baked in (design.md "已实测结论"):
//   - opencode's SSE bus is in-process: this server only sees sessions IT drives.
//     Terminal TUI sessions are observed via DirWatch instead.
//   - Two serve instances racing DB migration → "database is locked"; the daemon
//     must start this server early/alone so it wins migration.

// OpencodeServer manages the shared `opencode serve` process and HTTP client.
type OpencodeServer struct {
	cliPath  string
	password string

	mu               sync.Mutex
	cmd              *exec.Cmd
	cancel           context.CancelFunc
	baseURL          string // e.g. http://127.0.0.1:53211 (resolved from the server's stdout)
	outputPath       string // unique per serve; prevents concurrent starts reading another process's URL
	pid              int
	version          string
	identityNotAfter time.Time

	http     *http.Client // short ops (health, create, list, get)
	httpLong *http.Client // long ops (prompt — a turn can run for minutes)
}

// OpencodeHTTPStatusError reports an HTTP response status separately from its
// bounded body context so callers never infer status from untrusted body text.
type OpencodeHTTPStatusError struct {
	Method     string
	Path       string
	StatusCode int
	Body       string
}

func (e *OpencodeHTTPStatusError) Error() string {
	return fmt.Sprintf("opencode %s %s: status %d (body=%q)", e.Method, e.Path, e.StatusCode, e.Body)
}

// AttachOpencodeServer validates and adopts an already-running serve without
// launching another process. The endpoint must be loopback so credentials can
// never be sent to a host named by a tampered handoff file.
func AttachOpencodeServer(ctx context.Context, baseURL, password string, pid int, expectedVersion string, identityNotAfter time.Time) (*OpencodeServer, error) {
	u, err := url.Parse(baseURL)
	if err != nil || !validServeURL(u) {
		return nil, fmt.Errorf("invalid opencode serve URL")
	}
	if pid <= 0 || !platform.NewProcessController().IsAlive(pid) {
		return nil, fmt.Errorf("opencode serve pid %d is not alive", pid)
	}
	if err := validateProcessStartedBefore(pid, identityNotAfter); err != nil {
		return nil, fmt.Errorf("opencode serve pid identity mismatch: %w", err)
	}
	s := &OpencodeServer{
		password: password, baseURL: strings.TrimRight(baseURL, "/"), pid: pid, identityNotAfter: identityNotAfter,
		http: newHTTPClient(30 * time.Second), httpLong: newHTTPClient(0),
	}
	health, err := s.globalHealth(ctx)
	if err != nil || !health.Healthy {
		return nil, fmt.Errorf("authenticate opencode serve health: %w", err)
	}
	if expectedVersion == "" || health.Version != expectedVersion {
		return nil, fmt.Errorf("opencode serve version %q does not match %q", health.Version, expectedVersion)
	}
	s.version = health.Version
	return s, nil
}

func validServeURL(u *url.URL) bool {
	if u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	host := u.Hostname()
	if host != "localhost" && host != "127.0.0.1" && host != "::1" {
		return false
	}
	port, err := strconv.Atoi(u.Port())
	return err == nil && port >= 1 && port <= 65535
}

func newHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}

// NewOpencodeServer creates an (unstarted) server manager for the given opencode
// CLI binary path.
func NewOpencodeServer(cliPath string) *OpencodeServer {
	return &OpencodeServer{
		cliPath:  cliPath,
		password: randToken(),
		http:     newHTTPClient(30 * time.Second),
		httpLong: newHTTPClient(0), // no timeout: a prompt turn may take minutes
	}
}

var serveListenRe = regexp.MustCompile(`https?://[0-9.]+:\d+`)
var opencodeVersionRe = regexp.MustCompile(`^v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$`)

func DetectOpencodeVersion(ctx context.Context, cliPath string) (string, error) {
	out, err := exec.CommandContext(ctx, cliPath, "--version").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("opencode version: %w", err)
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		line = strings.TrimPrefix(line, "opencode version ")
		line = strings.TrimPrefix(line, "opencode ")
		if match := opencodeVersionRe.FindStringSubmatch(line); match != nil {
			return match[1], nil
		}
	}
	return "", fmt.Errorf("opencode version not found")
}

func opencodeServeOutputDir() string {
	home, err := config.HomeDir()
	if err != nil {
		return filepath.Join(".pocketctl", "logs")
	}
	return filepath.Join(home, ".pocketctl", "logs")
}

// Start launches `opencode serve --port 0`, parses the chosen base URL from its
// stdout, and waits until /api/health reports healthy. The context bounds
// startup; lifecycle ownership is explicit through Stop or Detach so a daemon
// handoff cannot accidentally kill the serve by canceling its old context.
func (s *OpencodeServer) Start(ctx context.Context) error {
	s.mu.Lock()
	if s.cmd != nil {
		s.mu.Unlock()
		return nil // already running
	}
	_, cancel := context.WithCancel(ctx)
	cmd := exec.Command(s.cliPath, "serve", "--port", "0")
	configureOpencodeServeProcess(cmd)
	// Force edit/bash to "ask" for daemon-driven sessions so this serve emits
	// permission.asked SSE events, which the coordinator surfaces as approval_request
	// cards for remote approval. Requests remain pending until an explicit reply;
	// PocketCtl does not impose an approval timeout. OPENCODE_CONFIG_CONTENT merges over the user's config
	// (model/provider/etc. preserved); it only affects THIS serve — terminal
	// `opencode` runs its own server with the user's own config.
	cmd.Env = append(os.Environ(),
		"OPENCODE_SERVER_PASSWORD="+s.password,
		`OPENCODE_CONFIG_CONTENT={"permission":{"edit":{"*":"ask"},"bash":{"*":"ask"}}}`,
	)
	outputDir := opencodeServeOutputDir()
	if err := os.MkdirAll(outputDir, 0o700); err != nil {
		cancel()
		s.mu.Unlock()
		return fmt.Errorf("create opencode output directory: %w", err)
	}
	if err := os.Chmod(outputDir, 0o700); err != nil {
		cancel()
		s.mu.Unlock()
		return err
	}
	output, err := os.CreateTemp(outputDir, "opencode-serve-*.log")
	if err != nil {
		cancel()
		s.mu.Unlock()
		return fmt.Errorf("open opencode output: %w", err)
	}
	outputPath := output.Name()
	_ = output.Chmod(0o600)
	cmd.Stdout = output
	cmd.Stderr = output
	if err := cmd.Start(); err != nil {
		output.Close()
		cancel()
		s.mu.Unlock()
		return fmt.Errorf("start opencode serve: %w", err)
	}
	// The child owns its duplicated handle; closing only the daemon's copy makes
	// the sink independent of the old daemon process across a restart.
	_ = output.Close()
	s.cmd = cmd
	s.cancel = cancel
	s.pid = cmd.Process.Pid
	s.outputPath = outputPath
	s.identityNotAfter = time.Now()
	s.mu.Unlock()

	// Parse the listening URL from stdout (line: "opencode server listening on http://127.0.0.1:PORT").
	base, perr := waitListenURLFromFile(outputPath, 0, 15*time.Second)
	if perr != nil {
		s.Stop()
		return fmt.Errorf("opencode serve did not report a listen URL: %w", perr)
	}
	s.mu.Lock()
	s.baseURL = base
	s.mu.Unlock()
	// Reap the child after it exits. This remains safe across Detach: Wait does
	// not terminate the process and prevents an attached shutdown leaving a zombie.
	go func() { _ = cmd.Wait() }()

	// Wait for health.
	if err := s.waitHealthy(ctx, 15*time.Second); err != nil {
		s.Stop()
		return err
	}
	health, err := s.globalHealth(ctx)
	if err != nil || !health.Healthy || health.Version == "" {
		s.Stop()
		return fmt.Errorf("opencode global health validation failed: %w", err)
	}
	s.mu.Lock()
	s.version = health.Version
	s.mu.Unlock()
	return nil
}

func waitListenURLFromFile(path string, offset int64, timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		f, err := os.Open(path)
		if err == nil {
			_, _ = f.Seek(offset, io.SeekStart)
			data, _ := io.ReadAll(io.LimitReader(f, 1<<20))
			_ = f.Close()
			if match := serveListenRe.Find(data); match != nil {
				raw := string(match)
				if parsed, parseErr := url.Parse(raw); parseErr == nil && validServeURL(parsed) {
					return raw, nil
				}
				return "", fmt.Errorf("opencode reported non-canonical listen URL")
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return "", fmt.Errorf("timed out waiting for listen URL")
}

// Stop terminates the server process. A locally launched process is addressed
// through its retained os.Process handle. An attached process is killed only
// after its authenticated endpoint is revalidated immediately beforehand.
func (s *OpencodeServer) Stop() error {
	s.mu.Lock()
	cancel := s.cancel
	pid := s.pid
	cmd := s.cmd
	version := s.version
	s.mu.Unlock()
	if cmd == nil && pid > 0 {
		if !platform.NewProcessController().IsAlive(pid) {
			s.mu.Lock()
			s.cmd, s.cancel, s.baseURL, s.pid = nil, nil, "", 0
			s.mu.Unlock()
			return nil
		}
		ctx, verifyCancel := context.WithTimeout(context.Background(), 3*time.Second)
		health, err := s.globalHealth(ctx)
		verifyCancel()
		if err != nil || !health.Healthy || health.Version != version {
			return fmt.Errorf("refuse to stop unverifiable opencode serve pid %d (healthy=%v version=%q): %v", pid, health.Healthy, health.Version, err)
		}
		if err := validateProcessStartedBefore(pid, s.identityNotAfter); err != nil {
			return fmt.Errorf("refuse to stop opencode pid identity mismatch: %w", err)
		}
	}
	var err error
	if pid > 0 {
		if cmd != nil && cmd.Process != nil {
			err = cmd.Process.Kill()
		} else {
			err = platform.NewProcessController().Kill(pid)
		}
	}
	if err != nil && !errors.Is(err, os.ErrProcessDone) && platform.NewProcessController().IsAlive(pid) {
		return err
	}
	if cancel != nil {
		cancel()
	}
	s.mu.Lock()
	s.cmd, s.cancel, s.baseURL, s.pid = nil, nil, "", 0
	s.mu.Unlock()
	return nil
}

// Detach relinquishes lifecycle ownership while leaving the serve running.
func (s *OpencodeServer) Detach() {
	s.mu.Lock()
	s.cmd = nil
	s.cancel = nil
	s.mu.Unlock()
}

// BaseURL returns the resolved server base URL ("" if not started).
func (s *OpencodeServer) BaseURL() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.baseURL
}

func (s *OpencodeServer) PID() int         { s.mu.Lock(); defer s.mu.Unlock(); return s.pid }
func (s *OpencodeServer) Version() string  { s.mu.Lock(); defer s.mu.Unlock(); return s.version }
func (s *OpencodeServer) Password() string { s.mu.Lock(); defer s.mu.Unlock(); return s.password }
func (s *OpencodeServer) OutputPath() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.outputPath
}

type opencodeGlobalHealth struct {
	Healthy bool   `json:"healthy"`
	Version string `json:"version"`
}

func (s *OpencodeServer) globalHealth(ctx context.Context) (opencodeGlobalHealth, error) {
	var out opencodeGlobalHealth
	err := s.get(ctx, "/global/health", &out)
	return out, err
}

func (s *OpencodeServer) waitHealthy(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return err
		}
		if out, err := s.globalHealth(ctx); err == nil && out.Healthy {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("opencode serve health check timed out")
}

// Healthy reports whether the server currently answers the documented global
// health endpoint without initializing a project-scoped instance.
func (s *OpencodeServer) Healthy(ctx context.Context) bool {
	out, err := s.globalHealth(ctx)
	return err == nil && out.Healthy
}

// ---- REST operations ----

// OpencodeModelRef identifies a model in opencode's provider/model space.
type OpencodeModelRef struct {
	ProviderID string `json:"providerID"`
	ID         string `json:"id,omitempty"`
	ModelID    string `json:"modelID,omitempty"`
	Variant    string `json:"variant,omitempty"`
}

type OpencodeCommand struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Agent       string   `json:"agent,omitempty"`
	Model       string   `json:"model,omitempty"`
	Source      string   `json:"source,omitempty"`
	Template    string   `json:"template"`
	Subtask     bool     `json:"subtask,omitempty"`
	Hints       []string `json:"hints"`
}

func (c *OpencodeCommand) UnmarshalJSON(data []byte) error {
	type commandAlias OpencodeCommand
	var wire struct {
		commandAlias
		Template json.RawMessage `json:"template"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}

	*c = OpencodeCommand(wire.commandAlias)
	var template any
	if len(wire.Template) > 0 {
		if err := json.Unmarshal(wire.Template, &template); err != nil {
			return err
		}
	}
	if value, ok := template.(string); ok {
		c.Template = value
	}
	return nil
}

type OpencodeAgent struct {
	Name        string
	Description string
	Mode        string
	Native      bool
	Hidden      bool
	Color       string
	Model       string
	Variant     string
}

// ListCommands returns OpenCode's directory-scoped command, MCP, and skill
// entries. The session layer maps these raw records to PocketCtl CommandItems.
func (s *OpencodeServer) ListCommands(ctx context.Context, directory string) ([]OpencodeCommand, error) {
	var out []OpencodeCommand
	if err := s.get(ctx, withDirectory("/command", directory), &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ExecuteCommand runs a known OpenCode slash command. This endpoint may invoke
// a model, so it deliberately uses the no-timeout client like Prompt.
func (s *OpencodeServer) ExecuteCommand(ctx context.Context, sessionID, directory, command, arguments string) error {
	body := map[string]any{"command": command, "arguments": arguments}
	path := "/session/" + url.PathEscape(sessionID) + "/command"
	return s.postWith(s.httpLong, ctx, withDirectory(path, directory), body, nil)
}

// ListAgents returns raw OpenCode Agent definitions. Product filtering (hidden
// and subagent-only entries) belongs to the session layer.
func (s *OpencodeServer) ListAgents(ctx context.Context, directory string) ([]OpencodeAgent, error) {
	var raw []struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Mode        string `json:"mode"`
		Native      bool   `json:"native"`
		Hidden      bool   `json:"hidden"`
		Color       string `json:"color"`
		Model       *struct {
			ProviderID string `json:"providerID"`
			ModelID    string `json:"modelID"`
		} `json:"model"`
		Variant string `json:"variant"`
	}
	if err := s.get(ctx, withDirectory("/agent", directory), &raw); err != nil {
		return nil, err
	}
	out := make([]OpencodeAgent, 0, len(raw))
	for _, item := range raw {
		agent := OpencodeAgent{
			Name: item.Name, Description: item.Description, Mode: item.Mode,
			Native: item.Native, Hidden: item.Hidden, Color: item.Color, Variant: item.Variant,
		}
		if item.Model != nil && item.Model.ProviderID != "" && item.Model.ModelID != "" {
			agent.Model = item.Model.ProviderID + "/" + item.Model.ModelID
		}
		out = append(out, agent)
	}
	return out, nil
}

func (s *OpencodeServer) SwitchAgent(ctx context.Context, sessionID, agent string) error {
	path := "/api/session/" + url.PathEscape(sessionID) + "/agent"
	return s.post(ctx, path, map[string]any{"agent": agent}, nil)
}

// CreateSession creates a session and returns its id. model and directory are
// optional; directory pins the session's working directory (LocationRef).
func (s *OpencodeServer) CreateSession(ctx context.Context, model *OpencodeModelRef, directory string) (string, error) {
	body := map[string]any{}
	if model != nil && model.ProviderID != "" && model.ID != "" {
		body["model"] = model
	}
	if directory != "" {
		body["location"] = map[string]string{"directory": directory}
	}
	var resp struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := s.post(ctx, "/api/session", body, &resp); err != nil {
		return "", err
	}
	if resp.Data.ID == "" {
		return "", fmt.Errorf("opencode create session: empty id in response")
	}
	return resp.Data.ID, nil
}

// Abort stops the current turn of a session (POST /session/{id}/abort — the
// legacy non-/api route, which is where opencode exposes abort).
func (s *OpencodeServer) Abort(ctx context.Context, sessionID string) error {
	return s.post(ctx, "/session/"+sessionID+"/abort", map[string]any{}, nil)
}

// Compact summarizes/compacts a session's history. It uses the legacy
// POST /session/{id}/summarize endpoint with the model in the body — the
// /api/session/{id}/compact endpoint is a stub in current opencode (returns 503
// "Session compact is not available yet"). model is "providerID/modelID"; when
// empty the session's own model is fetched. Uses the no-timeout client since
// summarization invokes the model.
func (s *OpencodeServer) Compact(ctx context.Context, sessionID, model string) error {
	providerID, modelID := splitModel(model)
	if providerID == "" || modelID == "" {
		if info, err := s.GetSession(ctx, sessionID); err == nil {
			providerID, modelID = info.Model.ProviderID, info.Model.ID
		}
	}
	body := map[string]any{"providerID": providerID, "modelID": modelID}
	return s.postWith(s.httpLong, ctx, "/session/"+sessionID+"/summarize", body, nil)
}

// Prompt sends a user message to a session and runs the turn. It uses the legacy
// POST /session/{id}/message endpoint with the model in the body — this is the
// only endpoint that actually executes a turn (the /api/.../prompt endpoint only
// *admits* a prompt with delivery:"steer" and never runs it on an idle session),
// and the model must be supplied in the body (it is NOT inherited from the
// session; a missing model falls back to the stale config default and fails with
// ProviderModelNotFoundError). model is "providerID/modelID"; when empty, the
// session's own model is fetched. Blocks until the turn completes (no-timeout
// client); callers run it in a goroutine and the message poller surfaces output.
func (s *OpencodeServer) Prompt(ctx context.Context, sessionID, model, sourceMessageID, text string) (OpencodeMessageWithParts, error) {
	providerID, modelID := splitModel(model)
	if providerID == "" || modelID == "" {
		if info, err := s.GetSession(ctx, sessionID); err == nil {
			providerID, modelID = info.Model.ProviderID, info.Model.ID
		}
	}
	body := map[string]any{
		"parts": []map[string]any{{"type": "text", "text": text}},
	}
	if sourceMessageID != "" {
		body["messageID"] = sourceMessageID
	}
	if providerID != "" && modelID != "" {
		body["model"] = map[string]string{"providerID": providerID, "modelID": modelID}
	}
	var result OpencodeMessageWithParts
	if err := s.postWith(s.httpLong, ctx, "/session/"+sessionID+"/message", body, &result); err != nil {
		return OpencodeMessageWithParts{}, err
	}
	if sourceMessageID == "" {
		return result, nil
	}
	if result.Info.Role != "assistant" || result.Info.ParentID != sourceMessageID {
		return OpencodeMessageWithParts{}, fmt.Errorf("opencode prompt source mismatch: expected %s, got parent %s", sourceMessageID, result.Info.ParentID)
	}
	return result, nil
}

const maxOpencodeMessageIDClockLead = 5 * time.Second

var (
	opencodeMessageIDMu       sync.Mutex
	opencodeLastReservedMilli int64
	// ErrOpencodeMessageIDEpochWrap means the session contains message IDs
	// from a previous 36-bit millisecond cycle. OpenCode v1.17.11 (and its
	// current upstream generator) compares those truncated IDs
	// lexicographically, so continuing the same session cannot be made safe by
	// choosing another external user-message ID; the session must be migrated
	// or forked by an upstream implementation that rewrites the identities.
	ErrOpencodeMessageIDEpochWrap = errors.New("opencode history crosses the 36-bit message-id epoch")
)

// ReserveOpencodeMessageID allocates the exact native source id that a
// managed outbound prompt will carry. OpenCode v1.17.11 selects the latest
// user/assistant by lexicographic message id, so an arbitrary external id can
// cause extra or runaway assistant turns. Match its ascending id layout,
// reserve strictly after every observed message, then wait until the local
// clock has passed the encoded millisecond so the server-generated assistant
// id is necessarily greater than the supplied user id.
func ReserveOpencodeMessageID(ctx context.Context, messages []OpencodeMessageWithParts) (string, error) {
	opencodeMessageIDMu.Lock()
	defer opencodeMessageIDMu.Unlock()

	nowMilli := time.Now().UnixMilli()
	const timestampMask = int64(1<<36) - 1
	nowEncodedMilli := nowMilli & timestampMask
	maxMilli := int64(0)
	for _, message := range messages {
		if message.Info.ID == "" {
			continue
		}
		millis, ok := opencodeMessageIDMillis(message.Info.ID)
		if !ok {
			return "", fmt.Errorf("opencode source identity preflight: unsupported message id %q", message.Info.ID)
		}
		if message.Info.Time.Created > 0 && message.Info.Time.Created>>36 < nowMilli>>36 && millis > nowEncodedMilli {
			return "", fmt.Errorf("opencode source identity preflight: %w; start a new session or migrate this history before sending", ErrOpencodeMessageIDEpochWrap)
		}
		if millis > maxMilli {
			maxMilli = millis
		}
	}
	targetMilli := nowMilli
	if maxMilli >= nowEncodedMilli {
		targetMilli += maxMilli - nowEncodedMilli + 1
	}
	if opencodeLastReservedMilli >= targetMilli {
		targetMilli = opencodeLastReservedMilli + 1
	}
	if targetMilli-nowMilli > maxOpencodeMessageIDClockLead.Milliseconds() {
		return "", fmt.Errorf("opencode source identity preflight: latest message clock is too far ahead")
	}

	wait := time.Duration(targetMilli-time.Now().UnixMilli()+1) * time.Millisecond
	if wait > 0 {
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-timer.C:
		}
	}

	random := make([]byte, 14)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("opencode source identity entropy: %w", err)
	}
	const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	for i := range random {
		random[i] = base62[int(random[i])%len(base62)]
	}
	// OpenCode's ascending generator stores timestamp*0x1000 + counter in
	// six big-endian bytes. A per-reservation millisecond makes counter=1 safe.
	encoded := (uint64(targetMilli&timestampMask) << 12) | 1
	var timeBytes [8]byte
	binary.BigEndian.PutUint64(timeBytes[:], encoded)
	opencodeLastReservedMilli = targetMilli
	return "msg_" + hex.EncodeToString(timeBytes[2:]) + string(random), nil
}

func opencodeMessageIDMillis(id string) (int64, bool) {
	if !strings.HasPrefix(id, "msg_") || len(id) != 30 {
		return 0, false
	}
	raw, err := hex.DecodeString(id[4:16])
	if err != nil || len(raw) != 6 {
		return 0, false
	}
	var full [8]byte
	copy(full[2:], raw)
	return int64(binary.BigEndian.Uint64(full[:]) >> 12), true
}

// splitModel splits "providerID/modelID" into its parts ("", "" when malformed).
func splitModel(model string) (providerID, modelID string) {
	model = strings.TrimSpace(model)
	if i := strings.Index(model, "/"); i > 0 && i < len(model)-1 {
		return model[:i], model[i+1:]
	}
	return "", ""
}

// SessionInfo is a subset of the session record used for liveness/title/model.
type SessionInfo struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Directory string `json:"directory"`
	Location  struct {
		Directory string `json:"directory"`
	} `json:"location"`
	Agent string `json:"agent"`
	Time  struct {
		Created int64 `json:"created"`
		Updated int64 `json:"updated"`
	} `json:"time"`
	Model struct {
		ProviderID string `json:"providerID"`
		ID         string `json:"id"`
	} `json:"model"`
}

// GetSession fetches a single session record (used for liveness checks).
func (s *OpencodeServer) GetSession(ctx context.Context, sessionID string) (*SessionInfo, error) {
	var resp struct {
		Data SessionInfo `json:"data"`
	}
	if err := s.get(ctx, "/api/session/"+url.PathEscape(sessionID), &resp); err != nil {
		return nil, err
	}
	// Current OpenCode returns location.directory; retain the top-level field
	// for older servers and normalize both shapes for all callers.
	if resp.Data.Directory == "" {
		resp.Data.Directory = resp.Data.Location.Directory
	}
	return &resp.Data, nil
}

// GetConfigModel returns opencode's effective default model ("provider/model")
// from GET /config. Used to give web-created sessions a model — opencode does
// not auto-apply the config default to API-created sessions, and a session with
// no model silently never runs prompts.
func (s *OpencodeServer) GetConfigModel(ctx context.Context) (string, error) {
	var cfg struct {
		Model string `json:"model"`
	}
	if err := s.get(ctx, "/config", &cfg); err != nil {
		return "", err
	}
	return cfg.Model, nil
}

// ListModels returns opencode's available models as ModelOptions. The Alias is
// "providerID/modelID" (round-trips through parseOpencodeModel when the client
// picks one); the Name is the same human-readable string. opencode's configured
// default model is placed first.
func (s *OpencodeServer) ListModels(ctx context.Context) ([]protocol.ModelOption, error) {
	var resp struct {
		Data []struct {
			ProviderID string `json:"providerID"`
			ID         string `json:"id"`
		} `json:"data"`
	}
	if err := s.get(ctx, "/api/model", &resp); err != nil {
		return nil, err
	}
	defaultModel, _ := s.GetConfigModel(ctx) // "providerID/modelID" or ""
	out := make([]protocol.ModelOption, 0, len(resp.Data))
	var def []protocol.ModelOption
	for _, m := range resp.Data {
		if m.ProviderID == "" || m.ID == "" {
			continue
		}
		key := m.ProviderID + "/" + m.ID
		opt := protocol.ModelOption{Alias: key, Name: key}
		if key == defaultModel {
			def = append(def, opt)
		} else {
			out = append(out, opt)
		}
	}
	return append(def, out...), nil
}

func (s *OpencodeServer) connectedProviders(ctx context.Context) (map[string]bool, error) {
	var resp struct {
		Connected []string `json:"connected"`
		All       []struct {
			ID        string `json:"id"`
			Connected bool   `json:"connected"`
		} `json:"all"`
	}
	if err := s.get(ctx, "/provider", &resp); err != nil {
		if err := s.get(ctx, "/api/provider", &resp); err != nil {
			return nil, err
		}
	}
	out := make(map[string]bool, len(resp.Connected)+len(resp.All))
	for _, id := range resp.Connected {
		if id != "" {
			out[id] = true
		}
	}
	for _, p := range resp.All {
		if p.ID != "" && p.Connected {
			out[p.ID] = true
		}
	}
	return out, nil
}

// ResolveDefaultModel picks a *valid* model for a session created without an
// explicit choice. opencode's configured default can be stale (e.g. a renamed
// model id like zhipuai-coding-plan/glm-5 → glm-5.2), which would fail the turn
// with ProviderModelNotFoundError. Preference order:
//  1. the config default, if it's still a valid model;
//  2. any valid model from the same provider as the config default (keeps the
//     provider the user has already authenticated);
//  3. the first available model.
//
// Returns "" only when no models are available.
func (s *OpencodeServer) ResolveDefaultModel(ctx context.Context) (string, error) {
	models, err := s.ListModels(ctx)
	if err != nil {
		return "", fmt.Errorf("list opencode models: %w", err)
	}
	if len(models) == 0 {
		return "", fmt.Errorf("no opencode models available")
	}
	connected, err := s.connectedProviders(ctx)
	if err != nil {
		return "", fmt.Errorf("list connected opencode providers: %w", err)
	}
	runnable := func(m protocol.ModelOption) bool {
		p, _, ok := strings.Cut(m.Alias, "/")
		return ok && connected[p]
	}
	cfgModel, _ := s.GetConfigModel(ctx)
	for _, m := range models {
		if m.Alias == cfgModel && runnable(m) {
			return m.Alias, nil
		}
	}
	if i := strings.Index(cfgModel, "/"); i > 0 {
		prov := cfgModel[:i]
		for _, m := range models {
			if strings.HasPrefix(m.Alias, prov+"/") && runnable(m) {
				return m.Alias, nil
			}
		}
	}
	for _, m := range models {
		if m.Alias == "opencode/deepseek-v4-flash-free" && runnable(m) {
			return m.Alias, nil
		}
	}
	for _, m := range models {
		if runnable(m) {
			return m.Alias, nil
		}
	}
	return "", fmt.Errorf("no connected opencode provider has a runnable model")
}

const opencodeDiscoverySessionLimit = 1000

// ListSessions returns a bounded, explicitly enlarged session window visible
// to the server (shared DB), used to discover terminal-started sessions.
// OpenCode defaults this endpoint to 50 rows, which hides older resumable
// sessions and prevents their history from reaching identity preflight.
// Current opencode persists sessions in SQLite, so this API — not the storage/
// file tree — is the source of truth.
func (s *OpencodeServer) ListSessions(ctx context.Context) ([]OpencodeSessionSummary, error) {
	var resp struct {
		Data []OpencodeSessionSummary `json:"data"`
	}
	if err := s.get(ctx, fmt.Sprintf("/api/session?limit=%d", opencodeDiscoverySessionLimit), &resp); err != nil {
		return nil, err
	}
	return resp.Data, nil
}

// GetMessages returns a session's full message+part history. Uses the legacy
// `/session/{id}/message` route (the `/api/session/{id}/message` variant returns
// an empty list for DB-backed sessions). The legacy route is project-scoped, so
// the session directory must be supplied for sessions created by a CLI running
// outside the daemon's working directory.
func (s *OpencodeServer) GetMessages(ctx context.Context, sessionID, directory string) ([]OpencodeMessageWithParts, error) {
	var out []OpencodeMessageWithParts
	path := "/session/" + url.PathEscape(sessionID) + "/message"
	if err := s.get(ctx, withDirectory(path, directory), &out); err != nil {
		return nil, err
	}
	return out, nil
}

// OpencodeSessionStatus is the native /session/status union. Type is one of
// idle, busy, or retry; retry carries the remaining fields.
type OpencodeSessionStatus struct {
	Type    string `json:"type"`
	Attempt int    `json:"attempt,omitempty"`
	Message string `json:"message,omitempty"`
	Next    int64  `json:"next,omitempty"`
}

func (s *OpencodeServer) ListSessionStatuses(ctx context.Context, directory string) (map[string]OpencodeSessionStatus, error) {
	out := make(map[string]OpencodeSessionStatus)
	if err := s.get(ctx, withDirectory("/session/status", directory), &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *OpencodeServer) ListTodos(ctx context.Context, sessionID, directory string) ([]protocol.TodoItem, error) {
	var out []protocol.TodoItem
	path := "/session/" + url.PathEscape(sessionID) + "/todo"
	if err := s.get(ctx, withDirectory(path, directory), &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ReplyPermission answers a tool-approval permission request. decision is one of
// "once" | "always" | "reject" (the EventPermissionReplied reply enum).
func (s *OpencodeServer) ReplyPermission(ctx context.Context, sessionID, requestID, decision string) error {
	return s.ReplyPermissionVersioned(ctx, sessionID, requestID, decision, PermissionVersionV2)
}

const (
	PermissionVersionLegacy = "legacy"
	PermissionVersionV2     = "v2"
)

func (s *OpencodeServer) ReplyPermissionVersioned(ctx context.Context, sessionID, requestID, decision, version string) error {
	return s.ReplyPermissionVersionedInDirectory(ctx, sessionID, requestID, decision, version, "")
}

// ReplyPermissionVersionedInDirectory answers a permission request in the
// OpenCode instance associated with directory. Legacy OpenCode permission
// state is instance-local, so omitting this query can address the right HTTP
// server but the wrong in-process project and return PermissionNotFoundError.
func (s *OpencodeServer) ReplyPermissionVersionedInDirectory(ctx context.Context, sessionID, requestID, decision, version, directory string) error {
	body := map[string]any{"reply": decision}
	if version == PermissionVersionLegacy {
		path := "/permission/" + url.PathEscape(requestID) + "/reply"
		return s.post(ctx, withDirectory(path, directory), body, nil)
	}
	path := "/api/session/" + url.PathEscape(sessionID) + "/permission/" + url.PathEscape(requestID) + "/reply"
	return s.post(ctx, path, body, nil)
}

func (s *OpencodeServer) ListPermissions(ctx context.Context, directory string) ([]PermissionAsked, error) {
	var raw []json.RawMessage
	if err := s.get(ctx, withDirectory("/permission", directory), &raw); err != nil {
		return nil, err
	}
	out := make([]PermissionAsked, 0, len(raw))
	for _, item := range raw {
		if permission, ok := ParsePermissionAsked(item); ok {
			out = append(out, permission)
		}
	}
	return out, nil
}

func (s *OpencodeServer) ListPermissionsV2(ctx context.Context, sessionID string) ([]PermissionAsked, error) {
	var raw []json.RawMessage
	path := "/api/session/" + url.PathEscape(sessionID) + "/permission"
	if err := s.get(ctx, path, &raw); err != nil {
		return nil, err
	}
	out := make([]PermissionAsked, 0, len(raw))
	for _, item := range raw {
		if permission, ok := ParsePermissionV2Asked(item); ok {
			out = append(out, permission)
		}
	}
	return out, nil
}

// ReplyQuestion answers an interactive question. answers is ordered per question;
// each answer is the list of selected option labels.
func (s *OpencodeServer) ReplyQuestion(ctx context.Context, sessionID, requestID string, answers [][]string) error {
	return s.ReplyQuestionVersioned(ctx, sessionID, requestID, answers, PermissionVersionV2, "")
}

func (s *OpencodeServer) ReplyQuestionVersioned(ctx context.Context, sessionID, requestID string, answers [][]string, version, directory string) error {
	body := map[string]any{"answers": answers}
	if version == PermissionVersionLegacy {
		path := "/question/" + url.PathEscape(requestID) + "/reply"
		return s.post(ctx, withDirectory(path, directory), body, nil)
	}
	path := "/api/session/" + url.PathEscape(sessionID) + "/question/" + url.PathEscape(requestID) + "/reply"
	return s.post(ctx, path, body, nil)
}

// RejectQuestion rejects (dismisses) an interactive question.
func (s *OpencodeServer) RejectQuestion(ctx context.Context, sessionID, requestID string) error {
	return s.RejectQuestionVersioned(ctx, sessionID, requestID, PermissionVersionV2, "")
}

func (s *OpencodeServer) RejectQuestionVersioned(ctx context.Context, sessionID, requestID, version, directory string) error {
	if version == PermissionVersionLegacy {
		path := "/question/" + url.PathEscape(requestID) + "/reject"
		return s.post(ctx, withDirectory(path, directory), map[string]any{}, nil)
	}
	path := "/api/session/" + url.PathEscape(sessionID) + "/question/" + url.PathEscape(requestID) + "/reject"
	return s.post(ctx, path, map[string]any{}, nil)
}

func (s *OpencodeServer) ListQuestions(ctx context.Context, directory string) ([]QuestionAsked, error) {
	var raw []json.RawMessage
	if err := s.get(ctx, withDirectory("/question", directory), &raw); err != nil {
		return nil, err
	}
	out := make([]QuestionAsked, 0, len(raw))
	for _, item := range raw {
		if question, ok := ParseQuestionAsked(item); ok {
			question.Version = PermissionVersionLegacy
			out = append(out, question)
		}
	}
	return out, nil
}

func (s *OpencodeServer) ListQuestionsV2(ctx context.Context, sessionID string) ([]QuestionAsked, error) {
	var raw []json.RawMessage
	path := "/api/session/" + url.PathEscape(sessionID) + "/question"
	if err := s.get(ctx, path, &raw); err != nil {
		return nil, err
	}
	out := make([]QuestionAsked, 0, len(raw))
	for _, item := range raw {
		if question, ok := ParseQuestionAsked(item); ok {
			question.Version = PermissionVersionV2
			out = append(out, question)
		}
	}
	return out, nil
}

// ---- SSE ----

// SSEEvent is one decoded line from the /event stream.
type SSEEvent struct {
	ID         string          `json:"id"`
	Type       string          `json:"type"`
	Directory  string          `json:"-"`
	Properties json.RawMessage `json:"properties"`
}

type globalSSEEnvelope struct {
	Directory string   `json:"directory"`
	Payload   SSEEvent `json:"payload"`
}

// Events connects to /event and streams decoded events until ctx is cancelled or
// the connection drops. The returned channel is closed on termination.
func (s *OpencodeServer) Events(ctx context.Context) (<-chan SSEEvent, error) {
	return s.events(ctx, "/event", func(payload []byte) (SSEEvent, error) {
		var event SSEEvent
		err := json.Unmarshal(payload, &event)
		return event, err
	})
}

// GlobalEvents connects to /global/event and unwraps each globally scoped
// envelope while retaining its directory on the decoded event.
func (s *OpencodeServer) GlobalEvents(ctx context.Context) (<-chan SSEEvent, error) {
	return s.events(ctx, "/global/event", func(payload []byte) (SSEEvent, error) {
		var envelope globalSSEEnvelope
		if err := json.Unmarshal(payload, &envelope); err != nil {
			return SSEEvent{}, err
		}
		envelope.Payload.Directory = envelope.Directory
		return envelope.Payload, nil
	})
}

func (s *OpencodeServer) events(ctx context.Context, path string, decode func([]byte) (SSEEvent, error)) (<-chan SSEEvent, error) {
	base := s.BaseURL()
	if base == "" {
		return nil, fmt.Errorf("opencode server not started")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
	if err != nil {
		return nil, err
	}
	s.auth(req)
	// No client timeout for the long-lived SSE stream.
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("opencode %s status %d", path, resp.StatusCode)
	}
	out := make(chan SSEEvent, 64)
	go func() {
		defer close(out)
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 1024*1024), 4*1024*1024)
		for sc.Scan() {
			line := sc.Text()
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if payload == "" {
				continue
			}
			ev, err := decode([]byte(payload))
			if err != nil {
				continue
			}
			select {
			case out <- ev:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out, nil
}

// PermissionAsked is the normalized legacy/v2 OpenCode permission request.
type PermissionAsked struct {
	ID         string
	SessionID  string
	Permission string
	// Tool is retained as a compatibility alias for existing approval code.
	Tool          string
	Title         string
	Patterns      []string
	Always        []string
	Metadata      json.RawMessage
	ToolMessageID string
	ToolCallID    string
	Version       string
}

type permissionWire struct {
	ID           string          `json:"id"`
	RequestID    string          `json:"requestID"`
	PermissionID string          `json:"permissionID"`
	SessionID    string          `json:"sessionID"`
	Permission   string          `json:"permission"`
	Type         string          `json:"type"`
	ToolName     string          `json:"toolName"`
	Title        string          `json:"title"`
	Patterns     []string        `json:"patterns"`
	Always       []string        `json:"always"`
	Metadata     json.RawMessage `json:"metadata"`
	Tool         struct {
		MessageID string `json:"messageID"`
		CallID    string `json:"callID"`
	} `json:"tool"`
}

func ParsePermissionAsked(props json.RawMessage) (PermissionAsked, bool) {
	raw, ok := nestedObject(props, "request", "permission")
	if !ok {
		return PermissionAsked{}, false
	}
	var wire permissionWire
	if json.Unmarshal(raw, &wire) != nil {
		return PermissionAsked{}, false
	}
	name := firstNonEmpty(wire.Permission, wire.Type, wire.ToolName)
	permission := PermissionAsked{
		ID: firstNonEmpty(wire.ID, wire.RequestID, wire.PermissionID), SessionID: wire.SessionID,
		Permission: name, Tool: name, Title: wire.Title, Patterns: wire.Patterns,
		Always: wire.Always, Metadata: wire.Metadata, ToolMessageID: wire.Tool.MessageID,
		ToolCallID: wire.Tool.CallID, Version: PermissionVersionLegacy,
	}
	if permission.ID == "" || permission.SessionID == "" {
		return PermissionAsked{}, false
	}
	return permission, true
}

func ParsePermissionV2Asked(props json.RawMessage) (PermissionAsked, bool) {
	raw, ok := nestedObject(props, "request", "permission")
	if !ok {
		return PermissionAsked{}, false
	}
	var wire struct {
		ID           string          `json:"id"`
		RequestID    string          `json:"requestID"`
		PermissionID string          `json:"permissionID"`
		SessionID    string          `json:"sessionID"`
		Action       string          `json:"action"`
		Resources    []string        `json:"resources"`
		Save         []string        `json:"save"`
		Metadata     json.RawMessage `json:"metadata"`
		Source       struct {
			MessageID string `json:"messageID"`
			CallID    string `json:"callID"`
		} `json:"source"`
	}
	if json.Unmarshal(raw, &wire) != nil || firstNonEmpty(wire.ID, wire.RequestID, wire.PermissionID) == "" || wire.SessionID == "" {
		return PermissionAsked{}, false
	}
	return PermissionAsked{
		ID: firstNonEmpty(wire.ID, wire.RequestID, wire.PermissionID), SessionID: wire.SessionID, Permission: wire.Action, Tool: wire.Action,
		Patterns: wire.Resources, Always: wire.Save, Metadata: wire.Metadata,
		ToolMessageID: wire.Source.MessageID, ToolCallID: wire.Source.CallID,
		Version: PermissionVersionV2,
	}, true
}

type QuestionAsked struct {
	ID            string
	SessionID     string
	Questions     []protocol.QuestionInfo
	ToolMessageID string
	ToolCallID    string
	Version       string
}

func ParseQuestionAsked(props json.RawMessage) (QuestionAsked, bool) {
	raw, ok := nestedObject(props, "request", "question")
	if !ok {
		return QuestionAsked{}, false
	}
	var wire struct {
		ID         string                  `json:"id"`
		RequestID  string                  `json:"requestID"`
		QuestionID string                  `json:"questionID"`
		SessionID  string                  `json:"sessionID"`
		Questions  []protocol.QuestionInfo `json:"questions"`
		Tool       struct {
			MessageID string `json:"messageID"`
			CallID    string `json:"callID"`
		} `json:"tool"`
	}
	if json.Unmarshal(raw, &wire) != nil || firstNonEmpty(wire.ID, wire.RequestID, wire.QuestionID) == "" || wire.SessionID == "" || len(wire.Questions) == 0 {
		return QuestionAsked{}, false
	}
	return QuestionAsked{
		ID: firstNonEmpty(wire.ID, wire.RequestID, wire.QuestionID), SessionID: wire.SessionID, Questions: wire.Questions,
		ToolMessageID: wire.Tool.MessageID, ToolCallID: wire.Tool.CallID, Version: PermissionVersionLegacy,
	}, true
}

func ParseRequestIdentity(props json.RawMessage) (requestID, sessionID string, ok bool) {
	raw, valid := nestedObject(props, "request", "permission", "question")
	if !valid {
		return "", "", false
	}
	var wire struct {
		ID           string `json:"id"`
		RequestID    string `json:"requestID"`
		PermissionID string `json:"permissionID"`
		QuestionID   string `json:"questionID"`
		SessionID    string `json:"sessionID"`
	}
	if json.Unmarshal(raw, &wire) != nil {
		return "", "", false
	}
	requestID = firstNonEmpty(wire.ID, wire.RequestID, wire.PermissionID, wire.QuestionID)
	return requestID, wire.SessionID, requestID != "" && wire.SessionID != ""
}

// ParsePermissionResolution preserves the decision carried by an out-of-band
// permission.replied event so other PocketCtl clients do not mistake every
// remote resolution for a rejection. OpenCode versions have used response,
// reply, and action for the same enum, so accept all three shapes.
func ParsePermissionResolution(props json.RawMessage) (requestID, sessionID, action string, ok bool) {
	raw, valid := nestedObject(props, "request", "permission")
	if !valid {
		return "", "", "", false
	}
	var wire struct {
		ID           string `json:"id"`
		RequestID    string `json:"requestID"`
		PermissionID string `json:"permissionID"`
		SessionID    string `json:"sessionID"`
		Response     string `json:"response"`
		Reply        string `json:"reply"`
		Action       string `json:"action"`
	}
	if json.Unmarshal(raw, &wire) != nil {
		return "", "", "", false
	}
	requestID = firstNonEmpty(wire.ID, wire.RequestID, wire.PermissionID)
	action = firstNonEmpty(wire.Response, wire.Reply, wire.Action)
	switch action {
	case "allow":
		action = "once"
	case "deny":
		action = "reject"
	}
	return requestID, wire.SessionID, action, requestID != "" && wire.SessionID != "" && protocol.ValidApprovalAction(action)
}

// ParseQuestionResolution keeps ordered answers when a different OpenCode
// client answered the request. Rejected events commonly omit answers.
func ParseQuestionResolution(props json.RawMessage) (requestID, sessionID string, answers [][]string, ok bool) {
	raw, valid := nestedObject(props, "request", "question")
	if !valid {
		return "", "", nil, false
	}
	var wire struct {
		ID         string     `json:"id"`
		RequestID  string     `json:"requestID"`
		QuestionID string     `json:"questionID"`
		SessionID  string     `json:"sessionID"`
		Answers    [][]string `json:"answers"`
	}
	if json.Unmarshal(raw, &wire) != nil {
		return "", "", nil, false
	}
	requestID = firstNonEmpty(wire.ID, wire.RequestID, wire.QuestionID)
	return requestID, wire.SessionID, wire.Answers, requestID != "" && wire.SessionID != ""
}

func ParseTodoUpdated(props json.RawMessage) (sessionID string, todos []protocol.TodoItem, ok bool) {
	raw, valid := nestedObject(props, "data")
	if !valid {
		return "", nil, false
	}
	var wire struct {
		SessionID string              `json:"sessionID"`
		Todos     []protocol.TodoItem `json:"todos"`
	}
	if json.Unmarshal(raw, &wire) != nil || wire.SessionID == "" {
		return "", nil, false
	}
	return wire.SessionID, wire.Todos, true
}

func nestedObject(props json.RawMessage, keys ...string) (json.RawMessage, bool) {
	var envelope map[string]json.RawMessage
	if json.Unmarshal(props, &envelope) != nil {
		return nil, false
	}
	for _, key := range keys {
		raw := envelope[key]
		if len(raw) > 0 && raw[0] == '{' {
			return raw, true
		}
	}
	return props, true
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// ---- HTTP helpers ----

func withDirectory(path, directory string) string {
	if directory == "" {
		return path
	}
	values := url.Values{}
	values.Set("directory", directory)
	return path + "?" + values.Encode()
}

func (s *OpencodeServer) auth(req *http.Request) {
	// opencode basic auth: username defaults to "opencode", password is the token.
	req.SetBasicAuth("opencode", s.password)
}

func (s *OpencodeServer) get(ctx context.Context, path string, out any) error {
	base := s.BaseURL()
	if base == "" {
		return fmt.Errorf("opencode server not started")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
	if err != nil {
		return err
	}
	s.auth(req)
	return s.do(req, out)
}

func (s *OpencodeServer) post(ctx context.Context, path string, body, out any) error {
	return s.postWith(s.http, ctx, path, body, out)
}

func (s *OpencodeServer) postWith(client *http.Client, ctx context.Context, path string, body, out any) error {
	base := s.BaseURL()
	if base == "" {
		return fmt.Errorf("opencode server not started")
	}
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+path, &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	s.auth(req)
	return s.doWith(client, req, out)
}

func (s *OpencodeServer) do(req *http.Request, out any) error {
	return s.doWith(s.http, req, out)
}

func (s *OpencodeServer) doWith(client *http.Client, req *http.Request, out any) error {
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return &OpencodeHTTPStatusError{
			Method: req.Method, Path: req.URL.Path, StatusCode: resp.StatusCode,
			Body: strings.TrimSpace(string(b)),
		}
	}
	if out == nil {
		io.Copy(io.Discard, resp.Body)
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// ---- misc ----

func randToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "pocketctl-opencode"
	}
	return hex.EncodeToString(b)
}

// parseListenURL scans the server's stdout until it finds the "listening on
// <url>" line or times out.
func parseListenURL(r io.Reader, timeout time.Duration) (string, error) {
	type res struct {
		url string
		err error
	}
	ch := make(chan res, 1)
	go func() {
		sc := bufio.NewScanner(r)
		for sc.Scan() {
			line := sc.Text()
			if strings.Contains(line, "listening on") {
				if m := serveListenRe.FindString(line); m != "" {
					ch <- res{url: m}
					return
				}
			}
		}
		if err := sc.Err(); err != nil {
			ch <- res{err: err}
			return
		}
		ch <- res{err: fmt.Errorf("opencode serve stdout closed before listen line")}
	}()
	select {
	case r := <-ch:
		return r.url, r.err
	case <-time.After(timeout):
		return "", fmt.Errorf("timeout waiting for listen line")
	}
}
