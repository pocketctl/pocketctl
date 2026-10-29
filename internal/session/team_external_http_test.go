package session

// This protocol exists only for fault-injection tests. It is deliberately not
// shipped as a provider adapter or advertised as AgentTeams/A2A compatibility.
import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"
)

type externalHTTPTestTransport struct {
	base   string
	client *http.Client
}

func (e *externalHTTPTestTransport) exchange(ctx context.Context, method, path string, input any, output any) error {
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, method, e.base+path, body)
	if err != nil {
		return err
	}
	response, err := e.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	// Generic HTTP errors never mean authoritative request absence.
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("stub HTTP status %d", response.StatusCode)
	}
	if output == nil {
		return nil
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 16385))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(output); err != nil {
		return err
	}
	var extra any
	if err = decoder.Decode(&extra); err != io.EOF {
		return errors.New("invalid stub response suffix")
	}
	return nil
}
func (e *externalHTTPTestTransport) Capabilities(ctx context.Context) (ExternalCapabilities, error) {
	var c ExternalCapabilities
	err := e.exchange(ctx, "GET", "/capabilities", nil, &c)
	return c, err
}
func (e *externalHTTPTestTransport) Submit(ctx context.Context, r ExternalExecutionRequest) (ExternalExecutionReceipt, error) {
	var receipt ExternalExecutionReceipt
	err := e.exchange(ctx, "POST", "/tasks", r, &receipt)
	return receipt, err
}

type externalHTTPLookup struct {
	Identity ExternalExecutionIdentity
	Found    bool
	Receipt  *ExternalExecutionReceipt
}

func (e *externalHTTPTestTransport) Lookup(ctx context.Context, id ExternalExecutionIdentity) (ExternalExecutionReceipt, error) {
	var result externalHTTPLookup
	query := url.Values{"request": {id.RequestID}}
	if err := e.exchange(ctx, "GET", "/lookup?"+query.Encode(), nil, &result); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	if result.Identity != id {
		return ExternalExecutionReceipt{}, ErrExternalIdentity
	}
	if !result.Found && result.Receipt == nil {
		return ExternalExecutionReceipt{}, ErrExternalNotFound
	}
	if !result.Found || result.Receipt == nil {
		return ExternalExecutionReceipt{}, ErrExternalReceipt
	}
	return *result.Receipt, nil
}
func (e *externalHTTPTestTransport) Cancel(ctx context.Context, id ExternalExecutionIdentity) error {
	return e.exchange(ctx, "POST", "/cancel", id, nil)
}

type externalHTTPFaultServer struct {
	mu                      sync.Mutex
	expected                ExternalExecutionRequest
	receipt                 *ExternalExecutionReceipt
	posts, lookups, cancels int
	lookupStatus            int
	dropSubmit              bool
}

func (s *externalHTTPFaultServer) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch r.Method + " " + r.URL.Path {
	case "GET /capabilities":
		_, caps := externalRequestFixture()
		_ = json.NewEncoder(w).Encode(caps)
	case "POST /tasks":
		s.posts++
		var request ExternalExecutionRequest
		if json.NewDecoder(io.LimitReader(r.Body, 6*1024*1024)).Decode(&request) != nil || request.Identity != s.expected.Identity || request.InputDigest != s.expected.InputDigest || !bytes.Equal(request.Input, s.expected.Input) {
			http.Error(w, "wrong request", 400)
			return
		}
		if s.receipt == nil {
			s.receipt = &ExternalExecutionReceipt{Identity: request.Identity, InputDigest: request.InputDigest, RemoteTaskID: "http-remote-task", Sequence: 1, State: ExternalRunning}
		}
		if s.dropSubmit {
			connection, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = connection.Close()
			}
			return
		}
		_ = json.NewEncoder(w).Encode(s.receipt)
	case "GET /lookup":
		s.lookups++
		if s.lookupStatus != 0 {
			http.Error(w, "stub failure", s.lookupStatus)
			return
		}
		if r.URL.Query().Get("request") != s.expected.Identity.RequestID {
			http.Error(w, "wrong key", 400)
			return
		}
		_ = json.NewEncoder(w).Encode(externalHTTPLookup{Identity: s.expected.Identity, Found: s.receipt != nil, Receipt: s.receipt})
	case "POST /cancel":
		var id ExternalExecutionIdentity
		if json.NewDecoder(r.Body).Decode(&id) != nil || id != s.expected.Identity {
			http.Error(w, "wrong identity", 400)
			return
		}
		s.cancels++
		w.WriteHeader(200)
	default:
		http.NotFound(w, r)
	}
}
func externalHTTPFixture(t *testing.T, r ExternalExecutionRequest) (*externalHTTPFaultServer, *externalHTTPTestTransport) {
	t.Helper()
	state := &externalHTTPFaultServer{expected: r}
	server := httptest.NewServer(http.HandlerFunc(state.serve))
	t.Cleanup(server.Close)
	client := server.Client()
	client.Timeout = 2 * time.Second
	return state, &externalHTTPTestTransport{base: server.URL, client: client}
}
func TestExternalHTTPLostResponseRestartRecoversOriginalTask(t *testing.T) {
	ctx := context.Background()
	r, _ := externalRequestFixture()
	state, transport := externalHTTPFixture(t, r)
	state.dropSubmit = true
	root := t.TempDir()
	j, err := OpenExternalJournal(root, r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	coordinator, _ := NewExternalCoordinator(j, transport, externalAllow)
	if _, err = coordinator.Start(ctx, r); !errors.Is(err, ErrExternalUnknown) {
		t.Fatal("expected connection loss", err)
	}
	if err = j.Close(); err != nil {
		t.Fatal(err)
	}
	j, err = OpenExternalJournal(root, r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	coordinator, _ = NewExternalCoordinator(j, transport, externalAllow)
	receipt, err := coordinator.Start(ctx, r)
	if err != nil || receipt.RemoteTaskID != "http-remote-task" {
		t.Fatal(err)
	}
	if err = coordinator.Revoke(ctx, r.Identity.CallID); err != nil {
		t.Fatal(err)
	}
	if _, err = coordinator.Recover(ctx, r.Identity.CallID); !errors.Is(err, ErrExternalRevoked) {
		t.Fatal(err)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.posts != 1 || state.lookups != 1 || state.cancels != 1 {
		t.Fatal(state.posts, state.lookups, state.cancels)
	}
}
func TestExternalHTTPRetryRequiresAuthoritativeMissingResult(t *testing.T) {
	for _, status := range []int{0, 401, 404, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			ctx := context.Background()
			r, _ := externalRequestFixture()
			state, transport := externalHTTPFixture(t, r)
			state.lookupStatus = status
			j, err := OpenExternalJournal(t.TempDir(), r.Identity.Scope)
			if err != nil {
				t.Fatal(err)
			}
			defer j.Close()
			if err = j.SaveIntent(ctx, r); err != nil {
				t.Fatal(err)
			}
			if ok, e := j.claimSubmission(ctx, r.Identity.CallID); e != nil || !ok {
				t.Fatal(ok, e)
			}
			coordinator, _ := NewExternalCoordinator(j, transport, externalAllow)
			receipt, err := coordinator.RetryOriginal(ctx, r.Identity.CallID, "explicit-confirmation")
			if status == 0 {
				if err != nil || receipt.RemoteTaskID != "http-remote-task" {
					t.Fatal(err)
				}
			} else if !errors.Is(err, ErrExternalUnknown) {
				t.Fatal(err)
			}
			state.mu.Lock()
			defer state.mu.Unlock()
			expected := 0
			if status == 0 {
				expected = 1
			}
			if state.posts != expected || state.lookups != 1 {
				t.Fatal(state.posts, state.lookups)
			}
		})
	}
}
