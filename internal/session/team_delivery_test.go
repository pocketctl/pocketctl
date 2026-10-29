package session

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestTeamDeliveryWorkspaceRequiresPrivateNativeBinding(t *testing.T) {
	policy, err := NewCwdPolicy([]string{t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	auth := *collaborationAuth("message", "call-delivery")
	auth.Delivery = &protocol.TeamDeliveryBinding{TaskID: "task-1", SpecRevision: 1}
	job := protocol.TeamDeliveryJob{CallID: auth.CallID, TaskID: "task-1", SpecRevision: 1, Revision: 1,
		NativeSessionID: "native-1", Provider: adapter.AgentCodex, Authorization: auth}
	cwd := collaborationWorkspace(policy.Roots()[0], auth.BindingID)
	if err := os.MkdirAll(cwd, 0700); err != nil {
		t.Fatal(err)
	}
	record := collaborationNativeRecord{Version: 1, Cwd: cwd, Binding: collaborationNativeBinding{
		NativeSessionID: job.NativeSessionID, Agent: job.Provider, TeamSessionID: auth.TeamSessionID,
		BindingID: auth.BindingID, BindingRevision: auth.BindingRevision, OfferID: auth.OfferID,
		OfferRevision: auth.OfferRevision, OwnerUserID: auth.OwnerUserID, DaemonID: auth.DaemonID}}
	data, _ := json.Marshal(record)
	if got, err := deliveryWorkspaceFromRecord(data, job, policy); err != nil || got != cwd {
		t.Fatalf("authorized source rejected: %q %v", got, err)
	}
	for name, mutate := range map[string]func(*protocol.TeamDeliveryJob){
		"call":              func(j *protocol.TeamDeliveryJob) { j.CallID = "other" },
		"task":              func(j *protocol.TeamDeliveryJob) { j.TaskID = "other" },
		"attempt":           func(j *protocol.TeamDeliveryJob) { j.AttemptID = "a1234567-1234-4234-8234-123456789abc" },
		"spec":              func(j *protocol.TeamDeliveryJob) { j.SpecRevision++ },
		"native":            func(j *protocol.TeamDeliveryJob) { j.NativeSessionID = "other" },
		"provider":          func(j *protocol.TeamDeliveryJob) { j.Provider = adapter.AgentClaude },
		"owner":             func(j *protocol.TeamDeliveryJob) { j.Authorization.OwnerUserID++ },
		"daemon":            func(j *protocol.TeamDeliveryJob) { j.Authorization.DaemonID = "other" },
		"offer revision":    func(j *protocol.TeamDeliveryJob) { j.Authorization.OfferRevision++ },
		"binding revision":  func(j *protocol.TeamDeliveryJob) { j.Authorization.BindingRevision++ },
		"missing authority": func(j *protocol.TeamDeliveryJob) { j.Authorization.Delivery = nil },
	} {
		t.Run(name, func(t *testing.T) {
			changed := job
			mutate(&changed)
			if _, err := deliveryWorkspaceFromRecord(data, changed, policy); err == nil {
				t.Fatal("incorrect source accepted")
			}
		})
	}
	record.Cwd = t.TempDir()
	data, _ = json.Marshal(record)
	if _, err := deliveryWorkspaceFromRecord(data, job, policy); err == nil {
		t.Fatal("unrelated workspace accepted")
	}
}
