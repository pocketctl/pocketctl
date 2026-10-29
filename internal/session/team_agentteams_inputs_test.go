package session

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/agentteams"
)

type agentTeamsInputRemote struct {
	*agentTeamsRemoteFixture
	loseUpload bool
}

func (f *agentTeamsInputRemote) SupportsFrozenInputs() bool { return true }
func (f *agentTeamsInputRemote) Call(ctx context.Context, tool string, args map[string]any) (json.RawMessage, error) {
	if tool != "pocketctl_inputs" {
		return f.agentTeamsRemoteFixture.Call(ctx, tool, args)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "pocketctl_inputs/upload_inputs")
	files, ok := args["files"].([]agentteams.InputFile)
	if !ok || agentteams.ValidateInputFiles(files) != nil || args["taskId"] != args["projectId"].(string)+"-01" {
		return nil, ErrExternalIdentity
	}
	if f.loseUpload {
		return nil, errors.New("upload response lost")
	}
	return json.RawMessage(`{"ok":true}`), nil
}

func TestAgentTeamsInputsUploadPrecedesDelegateAndLostResponseNeverRedelegates(t *testing.T) {
	for _, lost := range []bool{false, true} {
		t.Run(fmtBool(lost), func(t *testing.T) {
			remote := &agentTeamsInputRemote{agentTeamsRemoteFixture: &agentTeamsRemoteFixture{allowDelivery: true}, loseUpload: lost}
			j, _, r := agentTeamsFixture(t, t.TempDir(), remote.agentTeamsRemoteFixture)
			defer j.Close()
			e, err := NewAgentTeamsExecutor(j, AgentTeamsExecutorConfig{TeamID: "fixed-team", TeamRoomID: "!team:example.test", WorkerMatrixID: "@executor:example.test"}, remote, remote)
			if err != nil {
				t.Fatal(err)
			}
			files := []agentteams.InputFile{{Path: "inputs.json", Data: []byte(`{"schema_version":1}`)}, {Path: "files/" + strings.Repeat("a", 64), Data: []byte("original predecessor")}}
			for i := range files {
				files[i].SHA256 = externalPayloadDigest(files[i].Data)
			}
			r.Input, _ = json.Marshal(map[string]any{"spec": "Read exact predecessor", "inputs": files})
			r.InputDigest = externalPayloadDigest(r.Input)
			_, err = e.Submit(context.Background(), r)
			want := []string{"projectflow/create_project", "roomflow/create_task_room", "projectflow/plan_dag", "pocketctl_inputs/upload_inputs"}
			if lost {
				if !errors.Is(err, ErrExternalUnknown) {
					t.Fatal(err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				want = append(want, "taskflow/delegate_task")
			}
			if !reflect.DeepEqual(remote.calls, want) {
				t.Fatalf("upload/delegate order: %v", remote.calls)
			}
			_, _ = e.Submit(context.Background(), r)
			if !reflect.DeepEqual(remote.calls, want) {
				t.Fatal("lost upload retried or delegated")
			}
			if !lost && !strings.Contains(remote.lastSpec, "pocketctl-inputs/inputs.json") {
				t.Fatal("remote input references missing")
			}
		})
	}
}
