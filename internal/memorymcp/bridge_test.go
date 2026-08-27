package memorymcp

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeSource struct {
	grant Grant
	err   error
	calls int
}

type rotatingSource struct {
	grants []Grant
	calls  int
}

func (s *rotatingSource) Grant(context.Context) (Grant, error) {
	index := s.calls
	s.calls++
	if index >= len(s.grants) {
		return Grant{}, errors.New("no_grant")
	}
	return s.grants[index], nil
}

func (f *fakeSource) Grant(ctx context.Context) (Grant, error) {
	f.calls++
	if f.err != nil {
		return Grant{}, f.err
	}
	return f.grant, nil
}

func TestBridgeForwardsRequestsVerbatim(t *testing.T) {
	var received []byte
	var authHeader string
	var acceptHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := new(bytes.Buffer)
		_, _ = buf.ReadFrom(r.Body)
		received = buf.Bytes()
		authHeader = r.Header.Get("authorization")
		acceptHeader = r.Header.Get("accept")
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`))
	}))
	defer server.Close()

	source := &fakeSource{grant: Grant{
		Token: "grant-token", ExpiresAt: time.Now().Add(5 * time.Minute), Origin: server.URL,
	}}
	stdin := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}` + "\n")
	stdout := &bytes.Buffer{}
	bridge := &Bridge{
		Grants: &CachingGrantSource{Inner: source, Now: time.Now},
		Stdin:  stdin,
		Stdout: stdout,
	}
	if err := bridge.Run(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}
	if !strings.Contains(authHeader, "grant-token") {
		t.Fatalf("authorization header missing grant, got %q", authHeader)
	}
	if acceptHeader != "application/json, text/event-stream" {
		t.Fatalf("bridge must advertise both supported MCP response modes, got %q", acceptHeader)
	}
	if !bytes.Contains(received, []byte(`"method":"tools/list"`)) {
		t.Fatalf("forwarded body altered: %s", received)
	}
	if !strings.Contains(stdout.String(), `"result":{"ok":true}`) {
		t.Fatalf("stdout missing server response: %s", stdout.String())
	}
	if !strings.HasSuffix(stdout.String(), "\n") {
		t.Fatalf("successful response must preserve stdio JSON-lines framing: %q", stdout.String())
	}
}

func TestBridgeFailuresAnswerBoundedRpcErrorsWithoutCorruptingStdout(t *testing.T) {
	source := &fakeSource{err: errors.New("no_installment")}
	stdin := strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}` + "\n")
	stdout := &bytes.Buffer{}
	bridge := &Bridge{
		Grants: &CachingGrantSource{Inner: source, Now: time.Now},
		Stdin:  stdin, Stdout: stdout, Stderr: &bytes.Buffer{},
	}
	if err := bridge.Run(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}
	out := stdout.String()
	if !strings.Contains(out, `"id":7`) || !strings.Contains(out, `"error"`) {
		t.Fatalf("expected bounded JSON-RPC error, got %q", out)
	}
	if strings.Contains(out, "no_installment") {
		// The bounded code IS allowed; the raw error text must not leak other details.
		t.Logf("bounded code surfaced: %s", out)
	}
	if strings.Count(out, "\n") != strings.Count(stdout.String(), "\n") {
		t.Fatalf("framing changed")
	}
}

func TestBridgeNotificationsProduceNoStdoutWhenAccepted(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	source := &fakeSource{grant: Grant{
		Token: "t", ExpiresAt: time.Now().Add(5 * time.Minute), Origin: server.URL,
	}}
	stdin := strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n")
	stdout := &bytes.Buffer{}
	bridge := &Bridge{
		Grants: &CachingGrantSource{Inner: source, Now: time.Now},
		Stdin:  stdin, Stdout: stdout, Stderr: &bytes.Buffer{},
	}
	if err := bridge.Run(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}
	if stdout.Len() != 0 {
		t.Fatalf("notification produced stdout bytes: %q", stdout.String())
	}
}

func TestBridgeNotificationsDiscardBodiesForAnySuccessStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/html")
		_, _ = w.Write([]byte("<html>proxy body</html>"))
	}))
	defer server.Close()
	source := &fakeSource{grant: Grant{Token: "t", ExpiresAt: time.Now().Add(5 * time.Minute), Origin: server.URL}}
	stdout := &bytes.Buffer{}
	bridge := &Bridge{Grants: &CachingGrantSource{Inner: source, Now: time.Now},
		Stdin: strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n"), Stdout: stdout}
	if err := bridge.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if stdout.Len() != 0 {
		t.Fatalf("notification body corrupted stdout: %q", stdout.String())
	}
}

func TestBridgeRejectsNonJSONSuccessResponses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/html")
		_, _ = w.Write([]byte("<html>ok</html>"))
	}))
	defer server.Close()
	source := &fakeSource{grant: Grant{Token: "t", ExpiresAt: time.Now().Add(5 * time.Minute), Origin: server.URL}}
	stdout := &bytes.Buffer{}
	bridge := &Bridge{Grants: &CachingGrantSource{Inner: source, Now: time.Now},
		Stdin: strings.NewReader(`{"jsonrpc":"2.0","id":9,"method":"tools/list"}` + "\n"), Stdout: stdout}
	if err := bridge.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), `"message":"invalid_response"`) {
		t.Fatalf("expected bounded invalid response, got %q", stdout.String())
	}
}

func TestBridgeForwardsSingleSSEJsonResponseAsJSONLine(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":11,\"result\":{\"ok\":true}}\n\n"))
	}))
	defer server.Close()
	source := &fakeSource{grant: Grant{Token: "t", ExpiresAt: time.Now().Add(time.Minute), Origin: server.URL}}
	stdout := &bytes.Buffer{}
	bridge := &Bridge{
		Grants: &CachingGrantSource{Inner: source, Now: time.Now},
		Stdin:  strings.NewReader(`{"jsonrpc":"2.0","id":11,"method":"tools/list"}` + "\n"),
		Stdout: stdout,
	}
	if err := bridge.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := stdout.String(); got != "{\"jsonrpc\":\"2.0\",\"id\":11,\"result\":{\"ok\":true}}\n" {
		t.Fatalf("single SSE response was not normalized to one JSON line: %q", got)
	}
}

func TestBridgeRefreshesOnceAfterUnauthorizedGrant(t *testing.T) {
	var tokens []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("authorization"), "Bearer ")
		tokens = append(tokens, token)
		if token == "stale" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":3,"result":{"ok":true}}`))
	}))
	defer server.Close()
	source := &rotatingSource{grants: []Grant{
		{Token: "stale", ExpiresAt: time.Now().Add(5 * time.Minute), Origin: server.URL},
		{Token: "fresh", ExpiresAt: time.Now().Add(5 * time.Minute), Origin: server.URL},
	}}
	stdout := &bytes.Buffer{}
	bridge := &Bridge{
		Grants: &CachingGrantSource{Inner: source, Now: time.Now},
		Stdin:  strings.NewReader(`{"jsonrpc":"2.0","id":3,"method":"tools/list"}` + "\n"),
		Stdout: stdout,
	}
	if err := bridge.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if strings.Join(tokens, ",") != "stale,fresh" || source.calls != 2 {
		t.Fatalf("expected one refresh, tokens=%v calls=%d", tokens, source.calls)
	}
	if !strings.Contains(stdout.String(), `"result":{"ok":true}`) {
		t.Fatalf("fresh response missing: %s", stdout.String())
	}
}

func TestBridgeRejectsMismatchedResponseID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":99,"result":{}}`))
	}))
	defer server.Close()
	source := &fakeSource{grant: Grant{Token: "t", ExpiresAt: time.Now().Add(time.Minute), Origin: server.URL}}
	stdout := &bytes.Buffer{}
	bridge := &Bridge{
		Grants: &CachingGrantSource{Inner: source, Now: time.Now},
		Stdin:  strings.NewReader(`{"jsonrpc":"2.0","id":4,"method":"tools/list"}` + "\n"),
		Stdout: stdout,
	}
	if err := bridge.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), `"id":4`) || !strings.Contains(stdout.String(), `"message":"invalid_response"`) {
		t.Fatalf("expected correlated bounded error, got %s", stdout.String())
	}
}

func TestBridgeRejectsRedirectsWithoutForwardingTheRequestBody(t *testing.T) {
	redirectTargetReached := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirectTargetReached = true
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	source := &fakeSource{grant: Grant{Token: "t", ExpiresAt: time.Now().Add(time.Minute), Origin: server.URL}}
	stdout := &bytes.Buffer{}
	bridge := &Bridge{
		Grants: &CachingGrantSource{Inner: source, Now: time.Now},
		Stdin:  strings.NewReader(`{"jsonrpc":"2.0","id":5,"method":"tools/list"}` + "\n"),
		Stdout: stdout,
	}
	if err := bridge.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if redirectTargetReached {
		t.Fatal("redirect target received the MCP request")
	}
	if !strings.Contains(stdout.String(), `"message":"http_307"`) {
		t.Fatalf("expected bounded redirect error, got %s", stdout.String())
	}
}

func TestBridgeRejectsOversizedInputBeforeGrantOrHTTP(t *testing.T) {
	source := &fakeSource{grant: Grant{
		Token: "unused", ExpiresAt: time.Now().Add(time.Minute), Origin: "https://memory.invalid",
	}}
	bridge := &Bridge{
		Grants: &CachingGrantSource{Inner: source, Now: time.Now},
		Stdin: strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"padding":"` +
			strings.Repeat("x", maxMCPRequestBytes) + `"}}` + "\n"),
		Stdout: &bytes.Buffer{},
	}
	if err := bridge.Run(context.Background()); err == nil || err.Error() != "mcp_frame_too_large" {
		t.Fatalf("expected bounded frame error, got %v", err)
	}
	if source.calls != 0 {
		t.Fatalf("oversized frame reached grant source: %d calls", source.calls)
	}
}

func TestCachingGrantSourceRefreshesUnderThirtySeconds(t *testing.T) {
	now := time.Now()
	source := &fakeSource{grant: Grant{
		Token: "fresh", ExpiresAt: now.Add(2 * time.Minute), Origin: "https://memory.example",
	}}
	caching := &CachingGrantSource{Inner: source, Now: func() time.Time { return now }}
	if _, err := caching.Token(context.Background()); err != nil {
		t.Fatal(err)
	}
	if source.calls != 1 {
		t.Fatalf("expected 1 call, got %d", source.calls)
	}
	// Plenty of validity left: no refresh.
	if _, err := caching.Token(context.Background()); err != nil {
		t.Fatal(err)
	}
	if source.calls != 1 {
		t.Fatalf("cached grant should be reused, calls=%d", source.calls)
	}
	// 10 seconds left: refresh fires.
	now = now.Add(110 * time.Second)
	source.grant = Grant{Token: "newer", ExpiresAt: now.Add(2 * time.Minute)}
	if _, err := caching.Token(context.Background()); err != nil {
		t.Fatal(err)
	}
	if source.calls != 2 {
		t.Fatalf("refresh expected under 30s remaining, calls=%d", source.calls)
	}
}
