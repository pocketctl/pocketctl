package adapter

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

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

	mu      sync.Mutex
	cmd     *exec.Cmd
	cancel  context.CancelFunc
	baseURL string // e.g. http://127.0.0.1:53211 (resolved from the server's stdout)

	http     *http.Client // short ops (health, create, list, get)
	httpLong *http.Client // long ops (prompt — a turn can run for minutes)
}

// NewOpencodeServer creates an (unstarted) server manager for the given opencode
// CLI binary path.
func NewOpencodeServer(cliPath string) *OpencodeServer {
	return &OpencodeServer{
		cliPath:  cliPath,
		password: randToken(),
		http:     &http.Client{Timeout: 30 * time.Second},
		httpLong: &http.Client{}, // no timeout: a prompt turn may take minutes
	}
}

var serveListenRe = regexp.MustCompile(`https?://[0-9.]+:\d+`)

// Start launches `opencode serve --port 0`, parses the chosen base URL from its
// stdout, and waits until /api/health reports healthy. The process is bound to
// the given ctx; cancel it (or call Stop) to terminate the server.
func (s *OpencodeServer) Start(ctx context.Context) error {
	s.mu.Lock()
	if s.cmd != nil {
		s.mu.Unlock()
		return nil // already running
	}
	runCtx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(runCtx, s.cliPath, "serve", "--port", "0")
	// Force edit/bash to "ask" for daemon-driven sessions so this serve emits
	// permission.asked SSE events, which the coordinator surfaces as approval_request
	// cards for remote approval (and auto-rejects on timeout so an unattended turn
	// never hangs forever). OPENCODE_CONFIG_CONTENT merges over the user's config
	// (model/provider/etc. preserved); it only affects THIS serve — terminal
	// `opencode` runs its own server with the user's own config.
	cmd.Env = append(os.Environ(),
		"OPENCODE_SERVER_PASSWORD="+s.password,
		`OPENCODE_CONFIG_CONTENT={"permission":{"edit":{"*":"ask"},"bash":{"*":"ask"}}}`,
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		s.mu.Unlock()
		return fmt.Errorf("opencode serve stdout pipe: %w", err)
	}
	cmd.Stderr = cmd.Stdout // fold stderr in; the listen line may appear on either
	if err := cmd.Start(); err != nil {
		cancel()
		s.mu.Unlock()
		return fmt.Errorf("start opencode serve: %w", err)
	}
	s.cmd = cmd
	s.cancel = cancel
	s.mu.Unlock()

	// Parse the listening URL from stdout (line: "opencode server listening on http://127.0.0.1:PORT").
	base, perr := parseListenURL(stdout, 15*time.Second)
	if perr != nil {
		s.Stop()
		return fmt.Errorf("opencode serve did not report a listen URL: %w", perr)
	}
	s.mu.Lock()
	s.baseURL = base
	s.mu.Unlock()
	// Drain the rest of stdout so the process never blocks on a full pipe.
	go io.Copy(io.Discard, stdout)

	// Wait for health.
	if err := s.waitHealthy(ctx, 15*time.Second); err != nil {
		s.Stop()
		return err
	}
	return nil
}

// Stop terminates the server process.
func (s *OpencodeServer) Stop() {
	s.mu.Lock()
	cancel := s.cancel
	s.cmd = nil
	s.cancel = nil
	s.baseURL = ""
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// BaseURL returns the resolved server base URL ("" if not started).
func (s *OpencodeServer) BaseURL() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.baseURL
}

func (s *OpencodeServer) waitHealthy(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return err
		}
		var out struct {
			Healthy bool `json:"healthy"`
		}
		if err := s.get(ctx, "/api/health", &out); err == nil && out.Healthy {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("opencode serve health check timed out")
}

// Healthy reports whether the server currently answers /api/health.
func (s *OpencodeServer) Healthy(ctx context.Context) bool {
	var out struct {
		Healthy bool `json:"healthy"`
	}
	return s.get(ctx, "/api/health", &out) == nil && out.Healthy
}

// ---- REST operations ----

// OpencodeModelRef identifies a model in opencode's provider/model space.
type OpencodeModelRef struct {
	ProviderID string `json:"providerID"`
	ID         string `json:"id"`
	Variant    string `json:"variant,omitempty"`
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
func (s *OpencodeServer) Prompt(ctx context.Context, sessionID, model, text string) error {
	providerID, modelID := splitModel(model)
	if providerID == "" || modelID == "" {
		if info, err := s.GetSession(ctx, sessionID); err == nil {
			providerID, modelID = info.Model.ProviderID, info.Model.ID
		}
	}
	body := map[string]any{
		"parts": []map[string]any{{"type": "text", "text": text}},
	}
	if providerID != "" && modelID != "" {
		body["model"] = map[string]string{"providerID": providerID, "modelID": modelID}
	}
	return s.postWith(s.httpLong, ctx, "/session/"+sessionID+"/message", body, nil)
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
	Time      struct {
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
	if err := s.get(ctx, "/api/session/"+sessionID, &resp); err != nil {
		return nil, err
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

// ResolveDefaultModel picks a *valid* model for a session created without an
// explicit choice. opencode's configured default can be stale (e.g. a renamed
// model id like zhipuai-coding-plan/glm-5 → glm-5.2), which would fail the turn
// with ProviderModelNotFoundError. Preference order:
//  1. the config default, if it's still a valid model;
//  2. any valid model from the same provider as the config default (keeps the
//     provider the user has already authenticated);
//  3. the first available model.
// Returns "" only when no models are available.
func (s *OpencodeServer) ResolveDefaultModel(ctx context.Context) string {
	models, err := s.ListModels(ctx)
	if err != nil || len(models) == 0 {
		return ""
	}
	cfgModel, _ := s.GetConfigModel(ctx) // "providerID/modelID" or ""
	for _, m := range models {
		if m.Alias == cfgModel {
			return m.Alias // (1) config default still valid
		}
	}
	if i := strings.Index(cfgModel, "/"); i > 0 {
		prov := cfgModel[:i] + "/"
		for _, m := range models {
			if strings.HasPrefix(m.Alias, prov) {
				return m.Alias // (2) same provider, valid model
			}
		}
	}
	return models[0].Alias // (3) first available
}

// ListSessions returns all sessions visible to the server (shared DB), used to
// discover terminal-started sessions. Current opencode persists sessions in
// SQLite, so this API — not the storage/ file tree — is the source of truth.
func (s *OpencodeServer) ListSessions(ctx context.Context) ([]OpencodeSessionSummary, error) {
	var resp struct {
		Data []OpencodeSessionSummary `json:"data"`
	}
	if err := s.get(ctx, "/api/session", &resp); err != nil {
		return nil, err
	}
	return resp.Data, nil
}

// GetMessages returns a session's full message+part history. Uses the legacy
// `/session/{id}/message` route (the `/api/session/{id}/message` variant returns
// an empty list for DB-backed sessions).
func (s *OpencodeServer) GetMessages(ctx context.Context, sessionID string) ([]OpencodeMessageWithParts, error) {
	var out []OpencodeMessageWithParts
	if err := s.get(ctx, "/session/"+sessionID+"/message", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ReplyPermission answers a tool-approval permission request. decision is one of
// "once" | "always" | "reject" (the EventPermissionReplied reply enum).
func (s *OpencodeServer) ReplyPermission(ctx context.Context, sessionID, requestID, decision string) error {
	body := map[string]any{"reply": decision}
	return s.post(ctx, "/api/session/"+sessionID+"/permission/"+requestID+"/reply", body, nil)
}

// ReplyQuestion answers an interactive question. answers is ordered per question;
// each answer is the list of selected option labels.
func (s *OpencodeServer) ReplyQuestion(ctx context.Context, sessionID, requestID string, answers [][]string) error {
	body := map[string]any{"answers": answers}
	return s.post(ctx, "/api/session/"+sessionID+"/question/"+requestID+"/reply", body, nil)
}

// RejectQuestion rejects (dismisses) an interactive question.
func (s *OpencodeServer) RejectQuestion(ctx context.Context, sessionID, requestID string) error {
	return s.post(ctx, "/api/session/"+sessionID+"/question/"+requestID+"/reject", map[string]any{}, nil)
}

// ---- SSE ----

// SSEEvent is one decoded line from the /event stream.
type SSEEvent struct {
	ID         string          `json:"id"`
	Type       string          `json:"type"`
	Properties json.RawMessage `json:"properties"`
}

// Events connects to /event and streams decoded events until ctx is cancelled or
// the connection drops. The returned channel is closed on termination.
func (s *OpencodeServer) Events(ctx context.Context) (<-chan SSEEvent, error) {
	base := s.BaseURL()
	if base == "" {
		return nil, fmt.Errorf("opencode server not started")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/event", nil)
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
		return nil, fmt.Errorf("opencode /event status %d", resp.StatusCode)
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
			var ev SSEEvent
			if json.Unmarshal([]byte(payload), &ev) != nil {
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

// PermissionAsked is the decoded payload of a "permission.asked" (or
// "permission.replied") SSE event: enough to surface an approval card and route
// a reply. ID is the request id used by the reply route
// (POST /api/session/{sessionID}/permission/{ID}/reply).
type PermissionAsked struct {
	ID        string          // permission/request id
	SessionID string          // owning session
	Tool      string          // tool/permission type (e.g. "bash", "edit")
	Title     string          // human-readable summary, if provided
	Metadata  json.RawMessage // tool input / details (rendered in the card)
}

// ParsePermissionAsked decodes a permission event's properties. opencode has
// nested the permission under a few shapes across versions, so we probe both the
// flat object and a {permission:{...}} wrapper. ok is false unless both a request
// id and a session id are found.
func ParsePermissionAsked(props json.RawMessage) (PermissionAsked, bool) {
	type perm struct {
		ID           string          `json:"id"`
		RequestID    string          `json:"requestID"`
		PermissionID string          `json:"permissionID"`
		SessionID    string          `json:"sessionID"`
		Type         string          `json:"type"`
		ToolName     string          `json:"toolName"`
		Title        string          `json:"title"`
		Metadata     json.RawMessage `json:"metadata"`
	}
	var flat struct {
		perm
		Permission json.RawMessage `json:"permission"`
	}
	if json.Unmarshal(props, &flat) != nil {
		return PermissionAsked{}, false
	}
	merge := func(p perm) PermissionAsked {
		return PermissionAsked{
			ID:        firstNonEmpty(p.ID, p.RequestID, p.PermissionID),
			SessionID: p.SessionID,
			Tool:      firstNonEmpty(p.Type, p.ToolName),
			Title:     p.Title,
			Metadata:  p.Metadata,
		}
	}
	pa := merge(flat.perm)
	if (pa.ID == "" || pa.SessionID == "") && len(flat.Permission) > 0 {
		var inner perm
		if json.Unmarshal(flat.Permission, &inner) == nil {
			nested := merge(inner)
			if pa.ID == "" {
				pa.ID = nested.ID
			}
			if pa.SessionID == "" {
				pa.SessionID = nested.SessionID
			}
			if pa.Tool == "" {
				pa.Tool = nested.Tool
			}
			if pa.Title == "" {
				pa.Title = nested.Title
			}
			if len(pa.Metadata) == 0 {
				pa.Metadata = nested.Metadata
			}
		}
	}
	if pa.ID == "" || pa.SessionID == "" {
		return PermissionAsked{}, false
	}
	return pa, true
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
		return fmt.Errorf("opencode %s %s: status %d: %s", req.Method, req.URL.Path, resp.StatusCode, strings.TrimSpace(string(b)))
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
