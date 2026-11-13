package memorycontext

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

type tracedRoundTripper func(*http.Request) (*http.Response, error)

func (f tracedRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestContextDeliveryOverWebSocketAndTLSWithin750ms(t *testing.T) {
	const packID = "11111111-1111-4111-8111-111111111111"
	const evidence = "22222222-2222-4222-8222-222222222222"
	var mu sync.Mutex
	times := map[string]time.Time{}
	mark := func(phase string) {
		mu.Lock()
		times[phase] = time.Now()
		mu.Unlock()
	}
	wait := func(ctx context.Context, d time.Duration) bool {
		timer := time.NewTimer(d)
		defer timer.Stop()
		select {
		case <-timer.C:
			return true
		case <-ctx.Done():
			return false
		}
	}

	memory := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer fixture-grant" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch req.URL.Path {
		case "/api/v1/memory/context/compile":
			mark("compile_arrival")
			var input CompileRequest
			if json.NewDecoder(req.Body).Decode(&input) != nil || input.RepositoryHint == nil ||
				input.RepositoryHint.CommitSHA != "0123456789abcdef" {
				http.Error(w, "missing repository proof", http.StatusBadRequest)
				return
			}
			if wait(req.Context(), 215*time.Millisecond) {
				_ = json.NewEncoder(w).Encode(CompileResponse{Outcome: "ready", Pack: &WirePack{PackID: packID}})
			}
		case "/api/v1/memory/context/packs/" + packID + "/admit":
			mark("admit_arrival")
			if wait(req.Context(), 55*time.Millisecond) {
				_ = json.NewEncoder(w).Encode(AdmitResponse{InjectionID: "fixture-injection", Nonce: "fixture-nonce"})
			}
		case "/api/v1/memory/context/packs/" + packID + "/text":
			mark("text_arrival")
			if req.URL.Query().Get("nonce") != "fixture-nonce" {
				http.Error(w, "invalid nonce", http.StatusForbidden)
				return
			}
			if wait(req.Context(), 35*time.Millisecond) {
				_ = json.NewEncoder(w).Encode(PackText{PackID: packID, DynamicText: "evidence " + evidence})
			}
		default:
			http.NotFound(w, req)
		}
	}))
	defer memory.Close()
	httpsClient := memory.Client()
	transport := httpsClient.Transport
	httpsClient.Transport = tracedRoundTripper(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/compile") {
			trace := &httptrace.ClientTrace{
				GetConn:      func(string) { mark("http_connection_start") },
				GotConn:      func(httptrace.GotConnInfo) { mark("http_connection_ready") },
				WroteRequest: func(httptrace.WroteRequestInfo) { mark("compile_written") },
			}
			req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
		}
		return transport.RoundTrip(req)
	})

	upgrader := websocket.Upgrader{}
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		conn, err := upgrader.Upgrade(w, req, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			var request protocol.MemoryContextGrantRequest
			if conn.ReadJSON(&request) != nil {
				return
			}
			if request.Type != "memory_context_grant" {
				continue
			}
			mark("relay_request")
			if !wait(req.Context(), 310*time.Millisecond) {
				return
			}
			mark("relay_reply")
			if conn.WriteJSON(protocol.MemoryContextGrantResult{
				Type: "memory_context_grant_result", RequestID: request.RequestID, SessionID: request.SessionID,
				Grant: "fixture-grant", Services: []string{"memory.context"}, ProviderPublicOrigin: memory.URL,
			}) != nil {
				return
			}
		}
	}))
	defer relay.Close()

	socket, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(relay.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	grants := &GrantClient{Send: func(ctx context.Context, body []byte) error {
		mark("grant_send_start")
		deadline, _ := ctx.Deadline()
		_ = socket.SetWriteDeadline(deadline)
		return socket.WriteMessage(websocket.TextMessage, body)
	}}
	grants.Reply = grants.WaitReply
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		var reply protocol.ClientMessage
		if socket.ReadJSON(&reply) == nil {
			mark("daemon_reply")
			grants.Dispatch(reply)
		}
	}()
	defer func() {
		_ = socket.Close()
		<-readDone
	}()

	c := coordinator(grants, &httpClient{HTTP: httpsClient})
	c.resolveRepositoryHint = func(ctx context.Context, _ string) *RepositoryHint {
		mark("repository_start")
		if !wait(ctx, 170*time.Millisecond) {
			return nil
		}
		mark("repository_done")
		return &RepositoryHint{RepositoryID: "example.test/team/repo", CommitSHA: "0123456789abcdef"}
	}
	req := newTurn()
	req.Cwd = t.TempDir()
	mark("prepare_start")
	pack, outcome := c.Prepare(context.Background(), req)
	mark("pack_ready")

	mu.Lock()
	defer mu.Unlock()
	phases := [][2]string{
		{"grant_send_start", "relay_request"}, {"relay_request", "relay_reply"}, {"relay_reply", "daemon_reply"},
		{"repository_start", "repository_done"}, {"daemon_reply", "http_connection_start"},
		{"http_connection_start", "http_connection_ready"}, {"http_connection_ready", "compile_written"},
		{"compile_written", "compile_arrival"}, {"compile_arrival", "admit_arrival"},
		{"admit_arrival", "text_arrival"}, {"text_arrival", "pack_ready"}, {"prepare_start", "pack_ready"},
	}
	for _, phase := range phases {
		if start, end := times[phase[0]], times[phase[1]]; !start.IsZero() && !end.IsZero() {
			t.Logf("%s → %s: %v", phase[0], phase[1], end.Sub(start).Round(time.Millisecond))
		}
	}
	if pack == nil || outcome.Kind != "injected" || !strings.Contains(pack.DynamicText, evidence) {
		t.Fatalf("failed to deliver the bounded evidence payload: %s", outcome.Reason)
	}
	if elapsed := times["pack_ready"].Sub(times["prepare_start"]); elapsed > 750*time.Millisecond {
		t.Fatalf("pack consumed after the original deadline: %v", elapsed)
	}
	if !times["repository_done"].Before(times["daemon_reply"]) {
		t.Fatal("repository probe did not overlap the delayed Relay reply")
	}
}
