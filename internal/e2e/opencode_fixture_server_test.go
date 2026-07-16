package e2e

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// opencodeFixture is a deterministic HTTP fixture for release-gate scenarios.
// It models the directory-scoped legacy APIs and the global SSE envelope while
// allowing one-shot failures to exercise retry/replay behavior.
type opencodeFixture struct {
	mu                   sync.Mutex
	permission, question []map[string]any
	events               []map[string]any
	fail                 map[string]int
	replies              []map[string]any
}

func newOpencodeFixture() *opencodeFixture { return &opencodeFixture{fail: map[string]int{}} }
func (f *opencodeFixture) handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("/global/event", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, ev := range f.events {
			b, _ := json.Marshal(map[string]any{"directory": "/tmp/fixture", "payload": ev})
			fmt.Fprintf(w, "data: %s\n\n", b)
		}
	})
	m.HandleFunc("/permission", func(w http.ResponseWriter, r *http.Request) { f.listOrReply(w, r, "permission") })
	m.HandleFunc("/question", func(w http.ResponseWriter, r *http.Request) { f.listOrReply(w, r, "question") })
	m.HandleFunc("/command", func(w http.ResponseWriter, r *http.Request) {
		if f.consumeFail("command") {
			http.Error(w, "injected", 500)
			return
		}
		json.NewEncoder(w).Encode([]map[string]any{{"name": "build", "description": "Build", "template": map[string]any{}}})
	})
	m.HandleFunc("/session/ses_fixture/message", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{{"info": map[string]any{"id": "msg_fixture", "sessionID": "ses_fixture", "role": "assistant", "error": map[string]any{"name": "APIError", "data": map[string]any{"message": "provider auth failed"}}}, "parts": []any{}}})
	})
	m.HandleFunc("/api/session/ses_fixture", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": "ses_fixture", "directory": "/tmp/fixture", "agent": "build", "model": map[string]any{"providerID": "opencode", "id": "deepseek-v4-flash-free"}}})
	})
	m.HandleFunc("/api/session/ses_fixture/agent", func(w http.ResponseWriter, r *http.Request) {
		if f.consumeFail("agent") {
			http.Error(w, "injected", 500)
			return
		}
		w.WriteHeader(200)
	})
	for _, path := range []string{"/api/session/ses_fixture/todo", "/api/session/ses_fixture/status"} {
		p := path
		m.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			if strings.HasSuffix(p, "/todo") {
				json.NewEncoder(w).Encode([]map[string]any{{"id": "todo_1", "content": "fixture", "status": "pending"}})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"type": "retry", "attempt": 2})
		})
	}
	m.HandleFunc("/permission/per_1/reply", func(w http.ResponseWriter, r *http.Request) { f.listOrReply(w, r, "permission") })
	m.HandleFunc("/api/session/ses_fixture/permission/per_1/reply", func(w http.ResponseWriter, r *http.Request) { f.listOrReply(w, r, "permission") })
	m.HandleFunc("/api/session/ses_fixture/question/q_1/reply", func(w http.ResponseWriter, r *http.Request) { f.listOrReply(w, r, "question") })
	m.HandleFunc("/api/session/ses_fixture/question/q_1/reject", func(w http.ResponseWriter, r *http.Request) { f.listOrReply(w, r, "question") })
	m.HandleFunc("/api/session/ses_fixture/parts", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"page": r.URL.Query().Get("page"), "parts": []map[string]any{{"type": "retry", "attempt": 2}, {"type": "compaction", "auto": true}, {"type": "file", "filename": "a.go"}, {"type": "patch", "hash": "h1"}, {"type": "subtask", "agent": "explore"}, {"type": "profile", "name": "default"}}})
	})
	m.HandleFunc("/api/attach", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"attached": true, "pid": 1234, "version": "1.17.11"})
	})
	m.HandleFunc("/api/model", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"providerID": "opencode", "id": "deepseek-v4-flash-free"}}})
	})
	m.HandleFunc("/config", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"model": "stale/missing"})
	})
	m.HandleFunc("/provider", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"connected": []string{"opencode"}})
	})
	return m
}
func (f *opencodeFixture) consumeFail(name string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail[name] > 0 {
		f.fail[name]--
		return true
	}
	return false
}
func (f *opencodeFixture) listOrReply(w http.ResponseWriter, r *http.Request, kind string) {
	if r.Method == http.MethodPost {
		if f.consumeFail(kind) {
			http.Error(w, "injected", 500)
			return
		}
		var v map[string]any
		_ = json.NewDecoder(r.Body).Decode(&v)
		v["_path"] = r.URL.EscapedPath()
		f.mu.Lock()
		f.replies = append(f.replies, v)
		f.mu.Unlock()
		w.WriteHeader(200)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if kind == "permission" {
		json.NewEncoder(w).Encode(f.permission)
	} else {
		json.NewEncoder(w).Encode(f.question)
	}
}

func startOpencodeFixture(t *testing.T, f *opencodeFixture) (string, func()) {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Skipf("listener unavailable: %v", err)
	}
	s := &http.Server{Handler: f.handler()}
	go s.Serve(ln)
	return "http://" + ln.Addr().String(), func() { _ = s.Close(); _ = ln.Close() }
}

func TestOpencodeFixtureReleaseGateInteractionsAndFaults(t *testing.T) {
	f := newOpencodeFixture()
	f.permission = []map[string]any{{"id": "per_1", "sessionID": "ses_fixture", "permission": "bash"}}
	f.question = []map[string]any{{"id": "q_1", "sessionID": "ses_fixture", "questions": []any{map[string]any{"question": "continue?"}}}}
	f.events = []map[string]any{{"id": "evt_1", "type": "permission.asked", "properties": map[string]any{"id": "per_1", "sessionID": "ses_fixture"}}}
	base, stop := startOpencodeFixture(t, f)
	defer stop()
	for _, path := range []string{"/global/event?directory=/tmp/fixture", "/permission?directory=/tmp/fixture", "/question?directory=/tmp/fixture", "/command?directory=/tmp/fixture", "/api/model", "/config", "/provider"} {
		resp, err := http.Get(base + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("%s status %d", path, resp.StatusCode)
		}
	}
	// Exercise the exact production legacy/v2 reply and reject routes. Each
	// route fails once, succeeds on the identical retry, and records one body.
	replyCases := []struct {
		kind, path, body, field string
		want                    any
	}{
		{"permission", "/permission/per_1/reply", `{"reply":"once"}`, "reply", "once"},
		{"permission", "/api/session/ses_fixture/permission/per_1/reply", `{"reply":"always"}`, "reply", "always"},
		{"permission", "/api/session/ses_fixture/permission/per_1/reply", `{"reply":"reject"}`, "reply", "reject"},
		{"question", "/api/session/ses_fixture/question/q_1/reply", `{"answers":[["A"],["B","custom"]]}`, "answers", []any{[]any{"A"}, []any{"B", "custom"}}},
		{"question", "/api/session/ses_fixture/question/q_1/reject", `{}`, "_path", "/api/session/ses_fixture/question/q_1/reject"},
	}
	for _, tc := range replyCases {
		before := len(f.replies)
		f.fail[tc.kind] = 1
		for attempt := 0; attempt < 2; attempt++ {
			req, err := http.NewRequest(http.MethodPost, base+tc.path, strings.NewReader(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			wantStatus := http.StatusInternalServerError
			if attempt == 1 {
				wantStatus = http.StatusOK
			}
			if resp.StatusCode != wantStatus {
				t.Fatalf("%s attempt %d status=%d", tc.path, attempt, resp.StatusCode)
			}
		}
		if len(f.replies) != before+1 {
			t.Fatalf("%s persisted replies=%d, want %d", tc.path, len(f.replies), before+1)
		}
		if got := f.replies[len(f.replies)-1][tc.field]; !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%s body field %s=%#v, want %#v", tc.path, tc.field, got, tc.want)
		}
	}
	f.fail["command"] = 1
	for i := 0; i < 2; i++ {
		resp, _ := http.Get(base + "/command")
		resp.Body.Close()
		want := 500
		if i == 1 {
			want = 200
		}
		if resp.StatusCode != want {
			t.Fatalf("command attempt %d status=%d", i, resp.StatusCode)
		}
	}
	f.fail["agent"] = 1
	for i := 0; i < 2; i++ {
		req, _ := http.NewRequest(http.MethodPost, base+"/api/session/ses_fixture/agent", strings.NewReader(`{"agent":"build"}`))
		resp, _ := http.DefaultClient.Do(req)
		resp.Body.Close()
		want := 500
		if i == 1 {
			want = 200
		}
		if resp.StatusCode != want {
			t.Fatalf("agent attempt %d status=%d", i, resp.StatusCode)
		}
	}
	if len(f.replies) != len(replyCases) {
		t.Fatalf("successful replies=%d, want %d", len(f.replies), len(replyCases))
	}
}

func TestOpencodeFixtureReleaseGateSurface(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "opencode_release_gate.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		SessionID string `json:"session_id"`
		Cases     []struct {
			ID      string          `json:"id"`
			Event   string          `json:"event"`
			WebType string          `json:"web_type"`
			Payload json.RawMessage `json:"payload"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	if contract.SessionID != "ses_fixture" || len(contract.Cases) != 26 {
		t.Fatalf("invalid release contract: %+v", contract)
	}
	wantIDs := []string{
		"OC-105", "OC-205", "OC-301", "OC-302", "OC-303", "OC-304", "OC-305", "OC-306",
		"OC-401", "OC-402", "OC-403", "OC-404", "OC-405", "OC-406", "OC-407", "OC-501",
		"OC-502", "OC-505", "OC-506", "OC-602", "OC-605", "OC-701", "OC-702", "OC-705",
		"OC-802", "OC-804",
	}
	seen := make(map[string]bool, len(contract.Cases))
	for _, item := range contract.Cases {
		if item.Event == "" || item.WebType == "" || len(item.Payload) == 0 {
			t.Fatalf("case %s has incomplete contract: %+v", item.ID, item)
		}
		seen[item.ID] = true
	}
	for _, id := range wantIDs {
		if !seen[id] {
			t.Fatalf("release contract missing %s", id)
		}
	}
	f := newOpencodeFixture()
	base, stop := startOpencodeFixture(t, f)
	defer stop()
	for _, path := range []string{"/api/session/ses_fixture/todo", "/api/session/ses_fixture/status", "/api/session/ses_fixture/parts?page=2", "/api/attach"} {
		resp, err := http.Get(base + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s status=%d", path, resp.StatusCode)
		}
	}
	for _, path := range []string{"/permission/per_1/reply", "/api/session/ses_fixture/permission/per_1/reply", "/api/session/ses_fixture/question/q_1/reply", "/api/session/ses_fixture/question/q_1/reject"} {
		req, err := http.NewRequest(http.MethodPost, base+path, strings.NewReader(`{"answer":"ok"}`))
		if err != nil {
			t.Fatal(err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s status=%d", path, resp.StatusCode)
		}
	}
}
