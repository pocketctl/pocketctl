package session

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/pocketctl/pocketctl/internal/agentteams"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/teamdelivery"
	"github.com/pocketctl/pocketctl/internal/turn"
)

type stopTaskReader struct{ *agentTeamsRemoteFixture }

func (f stopTaskReader) Cancel(_ context.Context, b agentteams.TaskBinding, _ string, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if b.TaskID != f.task.TaskID {
		return ErrExternalIdentity
	}
	f.calls = append(f.calls, "cancel")
	f.task.Status = "cancelled"
	return nil
}
func TestAgentTeamsStopRecoversLostReplyAcrossRestartWithoutSecondStop(t *testing.T) {
	for _, lose := range []bool{false, true} {
		t.Run(fmtBool(lose), func(t *testing.T) {
			ctx := context.Background()
			var mu sync.Mutex
			status := "running"
			ended := ""
			posts := 0
			worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				if r.URL.Path == "/api/chats" {
					json.NewEncoder(w).Encode([]any{map[string]any{"id": "original", "session_id": "matrix:!original:example.test", "channel": "agentteams_matrix", "status": status, "last_finished_at": ended}, map[string]any{"id": "unrelated", "session_id": "matrix:!unrelated:example.test", "channel": "agentteams_matrix", "status": "running"}})
					return
				}
				if r.URL.Path != "/api/console/chat/stop" || r.URL.Query().Get("chat_id") != "original" {
					t.Error("wrong task stopped")
					w.WriteHeader(400)
					return
				}
				posts++
				status = "idle"
				ended = "2026-10-29T01:00:00Z"
				if lose {
					conn, _, _ := w.(http.Hijacker).Hijack()
					conn.Close()
					return
				}
				json.NewEncoder(w).Encode(map[string]any{"stopped": true})
			}))
			defer worker.Close()
			root := t.TempDir()
			f := &agentTeamsRemoteFixture{}
			j, e, r := agentTeamsFixture(t, root, f)
			e.reader = stopTaskReader{f}
			if err := e.ConfigureWorker(worker.URL, nil); err != nil {
				t.Fatal(err)
			}
			if _, err := e.Submit(ctx, r); err != nil {
				t.Fatal(err)
			}
			err := e.Cancel(ctx, r.Identity)
			if lose && !errors.Is(err, ErrExternalUnknown) {
				t.Fatal("lost stop reply did not remain unknown", err)
			}
			if !lose && err != nil {
				t.Fatal(err)
			}
			j.Close()
			j, e, _ = agentTeamsFixture(t, root, f)
			defer j.Close()
			e.reader = stopTaskReader{f}
			if err = e.ConfigureWorker(worker.URL, nil); err != nil {
				t.Fatal(err)
			}
			if err = e.Cancel(ctx, r.Identity); err != nil {
				t.Fatal("original stop not recovered", err)
			}
			mu.Lock()
			count := posts
			mu.Unlock()
			if count != 1 {
				t.Fatal("replayed model stop", count)
			}
			if _, err = e.Submit(ctx, r); !errors.Is(err, ErrExternalRevoked) {
				t.Fatal("cancelled original resubmitted", err)
			}
			var confirmed bool
			if err = j.db.QueryRow(`SELECT confirmed FROM agentteams_stop_intents WHERE call_id=?`, r.Identity.CallID).Scan(&confirmed); err != nil || !confirmed {
				t.Fatal("missing durable stop evidence", err)
			}
		})
	}
}
func TestAgentTeamsStopIdleWithoutRunningIntentIsUnknown(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/chats" {
			t.Error("unstarted chat stopped")
		}
		w.Write([]byte(`[{"id":"original","session_id":"matrix:!original:example.test","channel":"agentteams_matrix","status":"idle"}]`))
	}))
	defer worker.Close()
	f := &agentTeamsRemoteFixture{}
	j, e, r := agentTeamsFixture(t, t.TempDir(), f)
	defer j.Close()
	e.reader = stopTaskReader{f}
	e.ConfigureWorker(worker.URL, nil)
	if _, err := e.Submit(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if err := e.Cancel(context.Background(), r.Identity); !errors.Is(err, ErrExternalUnknown) {
		t.Fatal("queued work treated as stopped", err)
	}
}

type confirmedStopStub struct{ *externalStub }

func (s confirmedStopStub) Capabilities(ctx context.Context) (ExternalCapabilities, error) {
	c, err := s.externalStub.Capabilities(ctx)
	c.ModelStop = true
	return c, err
}
func TestAgentTeamsRuntimeInterruptRequiresConfirmedModelStop(t *testing.T) {
	for _, confirmed := range []bool{false, true} {
		t.Run(fmtBool(confirmed), func(t *testing.T) {
			ctx := context.Background()
			remote := &externalStub{}
			sm, j := agentTeamsRuntimeFixture(t, remote, func(context.Context, teamdelivery.ExternalAuthorizationRequest) error { return nil })
			if confirmed {
				sm.agentTeams.config.Executor = confirmedStopStub{remote}
			}
			native, err := sm.CreateCollaborationSessionRegistered(ctx, collaborationAuth("create", "call"), nil, "agentteams", "bounded", func(context.Context, string) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			if err = sm.agentTeams.advance(ctx, "call", false); err != nil {
				t.Fatal(err)
			}
			err = sm.sessions[native].Backend.Interrupt(native)
			_, receipt, readErr := j.Load(ctx, "call")
			if readErr != nil {
				t.Fatal(readErr)
			}
			if confirmed {
				if err != nil || receipt.State != ExternalCancelled {
					t.Fatal("confirmed stop did not persist cancelled receipt", err)
				}
				if last, ok := sm.turns.Last(turn.ActorKey{SessionID: native}); !ok || last.State != protocol.TurnStateInterrupted {
					t.Fatal("missing native interrupted state")
				}
				if err = sm.agentTeams.advance(ctx, "call", true); err != nil {
					t.Fatal("durable stop notification not replayed", err)
				}
			} else {
				if !errors.Is(err, ErrExternalUnknown) || receipt.State != ExternalRunning {
					t.Fatal("logical cancel treated as model stop", err)
				}
			}
			sm.ShutdownAgentTeams()
		})
	}
}
