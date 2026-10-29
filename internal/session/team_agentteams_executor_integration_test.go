package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/agentteams"
)

type agentTeamsLoseOneResponse struct {
	actual    AgentTeamsMCP
	deny      bool
	delegates int
}

func (m *agentTeamsLoseOneResponse) Call(ctx context.Context, tool string, args map[string]any) (json.RawMessage, error) {
	if m.deny {
		return nil, errors.New("mutation forbidden during restart recovery")
	}
	result, err := m.actual.Call(ctx, tool, args)
	if tool == "taskflow" && args["action"] == "delegate_task" && err == nil {
		m.delegates++
		var frame struct {
			OK bool `json:"ok"`
		}
		if json.Unmarshal(result, &frame) == nil && frame.OK {
			return nil, errors.New("injected response loss after real delegation")
		}
	}
	return result, err
}

// This exercises the actual durable bridge and real upstream Worker. It is not
// a Relay Call/grant/attempt or human-acceptance test and cannot close D19.
func TestAgentTeamsRealBridgeLostResponseRecovery(t *testing.T) {
	if os.Getenv("AGENTTEAMS_T17_BRIDGE_ACCEPTANCE") != "1" {
		t.Skip("explicit dedicated Docker bridge acceptance required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	const container = "pocketctl-team-external-t17-controller-1"
	inspect, err := exec.CommandContext(ctx, "docker", "inspect", container).Output()
	if err != nil {
		t.Fatal("dedicated controller unavailable")
	}
	var c []struct {
		Image      string
		Config     struct{ Labels map[string]string }
		Mounts     []struct{ Type, Name string }
		HostConfig struct{ Privileged bool }
	}
	if json.Unmarshal(inspect, &c) != nil || len(c) != 1 || c[0].Config.Labels["com.docker.compose.project"] != "pocketctl-team-external-t17" || c[0].HostConfig.Privileged {
		t.Fatal("wrong dedicated deployment")
	}
	if c[0].Image != "sha256:f3a5828f576bd9d9cf9a59af704af45f0e17e9b7c4d62e4564adac0b3d7dee97" {
		t.Fatal("upstream image changed")
	}
	for _, mount := range c[0].Mounts {
		if mount.Type != "volume" || !strings.HasPrefix(mount.Name, "pocketctl-team-external-t17_") {
			t.Fatal("unexpected host mount")
		}
	}
	token := func(ctx context.Context) (string, error) {
		value, err := exec.CommandContext(ctx, "docker", "exec", container, "cat", "/data/pocketctl-t17-bridge/t17-bridge.token").Output()
		if err != nil {
			return "", agentteams.ErrCredential
		}
		return strings.TrimSpace(string(value)), nil
	}
	reader, err := agentteams.NewClient("http://127.0.0.1:19101", token, nil)
	if err != nil {
		t.Fatal(err)
	}
	mcp, err := agentteams.NewMCPProcess([]string{"docker", "exec", "-i", container, "python3"}, "/data/pocketctl-t17-bridge/mcp.json")
	if err != nil {
		t.Fatal(err)
	}
	private := "/tmp/pocketctl-team-external-t17/go-bridge-journal"
	const scope = "t17-bridge-probe-installation-20261028"
	const installation = "agentteams-v1.2.5-t17-20261028"
	var j *ExternalJournal
	if os.Getenv("AGENTTEAMS_T17_BRIDGE_INITIALIZE") == "1" {
		j, err = InitializeAgentTeamsJournal(private, scope, installation)
	} else {
		j, err = OpenAgentTeamsJournal(private, scope, installation)
	}
	if err != nil {
		t.Fatal("bridge store not ready; do not reset it", err)
	}
	defer func() {
		if j != nil {
			j.Close()
		}
	}()
	config := AgentTeamsExecutorConfig{TeamID: "t17-pocketctl", TeamRoomID: "!dF3664xTRJaoMc1uhl:t17-matrix.local", WorkerMatrixID: "@t17-executor:t17-matrix.local"}
	lost := &agentTeamsLoseOneResponse{actual: mcp}
	e, err := NewAgentTeamsExecutor(j, config, lost, reader)
	if err != nil {
		t.Fatal(err)
	}
	id := ExternalExecutionIdentity{Scope: scope, CallID: "t17-durable-bridge-probe-01", OfferID: "fixed-t17-executor", RequestID: "original-bridge-probe-request-01"}
	b := e.binding(id)
	path := "shared/tasks/" + b.TaskID + "/proof.md"
	input, _ := json.Marshal(AgentTeamsTaskInput{Spec: fmt.Sprintf("This is one bounded PocketCtl bridge transport probe, not a human acceptance decision. Work only on task %s in project %s. Acknowledge using taskflow ack_task. Write %s with exactly the ASCII content T17-DURABLE-BRIDGE-ORIGINAL followed by one newline. Use the .md path exactly; do not use .txt or a BOM. Read back the file, then call taskflow submit_task once, result status SUCCESS, deliverables [\"%s\"]. Do not accept, create, delegate, retry, use shell/browser/subagents, contact anyone else, or modify another path. On an error report BLOCKED without retrying.", b.TaskID, b.ProjectID, path, path)})
	r := ExternalExecutionRequest{Identity: id, Input: input, InputDigest: externalPayloadDigest(input)}
	if _, err = e.Submit(ctx, r); err != nil && !errors.Is(err, ErrExternalUnknown) {
		t.Fatal("original bridge submit failed", err)
	}
	if err = j.Close(); err != nil {
		t.Fatal(err)
	}
	j = nil
	j, err = OpenAgentTeamsJournal(private, scope, installation)
	if err != nil {
		t.Fatal(err)
	}
	readOnly := &agentTeamsLoseOneResponse{deny: true}
	e, err = NewAgentTeamsExecutor(j, config, readOnly, reader)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := e.Submit(ctx, r)
	if err != nil && !errors.Is(err, ErrExternalUnknown) {
		t.Fatal("restarted original submit", err)
	}
	for err != nil || !externalTerminal(receipt.State) {
		select {
		case <-ctx.Done():
			t.Fatal("original bridge task remains unresolved; preserve store", ctx.Err())
		case <-time.After(time.Second):
		}
		receipt, err = e.Lookup(ctx, id)
		if err != nil && !errors.Is(err, ErrExternalUnknown) && !errors.Is(err, ErrExternalConflict) {
			t.Fatal(err)
		}
	}
	if receipt.State != ExternalSucceeded || receipt.RemoteSubmissionID == "" {
		t.Fatal("original task did not succeed", receipt.State)
	}
	snapshot, err := e.ExportArtifact(ctx, id, path, 4096)
	if err != nil {
		t.Fatal(err)
	}
	data := snapshot.Data
	if string(data) != "T17-DURABLE-BRIDGE-ORIGINAL\n" {
		t.Fatal("real proof does not match exact frozen ASCII bytes")
	}
	var operations int
	if err = j.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM agentteams_operations WHERE call_id=?`, id.CallID).Scan(&operations); err != nil || operations != 4 {
		t.Fatal("unexpected mutation operation count", operations, err)
	}
	result := map[string]any{"at": time.Now().UTC().Format(time.RFC3339), "status": "PASS_REAL_DURABLE_BRIDGE_RECOVERY_ONLY", "identity": id, "project": b.ProjectID, "task": b.TaskID, "submission": receipt.RemoteSubmissionID, "inputDigest": r.InputDigest, "receiptSequence": receipt.Sequence, "artifact": map[string]any{"path": path, "bytes": len(data), "sha256": externalPayloadDigest(data), "durableSnapshot": true}, "durableMutationOperations": operations, "newDelegationsThisRun": lost.delegates, "recoveryMutations": 0, "pocketctlCallLinked": false, "humanAcceptance": false, "scope": "Real upstream assignment; injected response loss on initial run; reopened SQLite store; original request recovered read-only. Not D19 product acceptance."}
	encoded, _ := json.MarshalIndent(result, "", "  ")
	report := filepath.Join("../../docs/reports/team-delivery/p2/20261028-agentteams-t17", "real-bridge-recovery.json")
	if err = os.WriteFile(report, append(encoded, '\n'), 0644); err != nil {
		t.Fatal(err)
	}
}
