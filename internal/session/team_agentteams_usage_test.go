package session

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestAgentTeamsUsageBoundFrozenAndRevoked(t *testing.T) {
	ctx := context.Background()
	var reads atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		switch r.URL.Path {
		case "/api/chats":
			w.Write([]byte(`[{"id":"chat","session_id":"matrix:!original:example.test","channel":"agentteams_matrix"}]`))
		case "/api/chats/chat":
			w.Write([]byte(`{"status":"idle","messages":[{"role":"assistant","metadata":{"original_id":"original-turn","finished_at":"2026-10-28T10:00:00Z","metadata":{"qwenpaw_turn_usage":{"usage":{"model_name":"m","prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"cache_read_tokens":80,"cache_write_tokens":0}}}}}]}`))
		default:
			t.Error("unexpected worker path")
			w.WriteHeader(404)
		}
	}))
	defer worker.Close()
	root := t.TempDir()
	remote := &agentTeamsRemoteFixture{}
	j, e, r := agentTeamsFixture(t, root, remote)
	if err := e.ConfigureWorker(worker.URL, nil); err != nil {
		t.Fatal(err)
	}
	if err := e.ConfigureWorker(worker.URL+"/changed", nil); err == nil {
		t.Fatal("changed worker accepted")
	}
	if _, err := e.Submit(ctx, r); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Usage(ctx, r.Identity); err == nil || reads.Load() != 0 {
		t.Fatal("unfinished call metered")
	}
	remote.task.Status = "submitted"
	remote.task.ResultStatus = "SUCCESS"
	remote.task.SubmissionID = "original-submission"
	if _, err := e.Lookup(ctx, r.Identity); err != nil {
		t.Fatal(err)
	}
	h, err := NewAgentTeamsBridgeHandler(e, "installation", func(context.Context) (string, error) { return "secret", nil })
	if err != nil {
		t.Fatal(err)
	}
	bridge := httptest.NewServer(h)
	defer bridge.Close()
	client, _ := NewAgentTeamsBridgeClient(bridge.URL, "installation", func(context.Context) (string, error) { return "secret", nil }, nil)
	result, err := client.Usage(ctx, r.Identity)
	if err != nil || result.Identity != r.Identity || len(result.Usage.Turns) != 1 || result.Usage.Turns[0].InputTokens != 20 {
		t.Fatalf("bad result %+v %v", result, err)
	}
	j.Close()
	j, e, _ = agentTeamsFixture(t, root, remote)
	defer j.Close()
	if err = e.ConfigureWorker(worker.URL, nil); err != nil {
		t.Fatal(err)
	}
	cached, err := e.Usage(ctx, r.Identity)
	a, _ := json.Marshal(result)
	b, _ := json.Marshal(cached)
	if err != nil || string(a) != string(b) || reads.Load() != 2 {
		t.Fatal("restart lost frozen usage", err)
	}
	wrong := r.Identity
	wrong.RequestID = "another"
	if _, err = e.Usage(ctx, wrong); err == nil {
		t.Fatal("different request accepted")
	}
	if _, err = j.db.Exec(`INSERT INTO external_revocations(call_id) VALUES(?)`, r.Identity.CallID); err != nil {
		t.Fatal(err)
	}
	if _, err = e.Usage(ctx, r.Identity); !errors.Is(err, ErrExternalRevoked) {
		t.Fatal("revoked cached usage exposed", err)
	}
}
