package session

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/pocketctl/pocketctl/internal/agentteams"
)

// The network double models only upstream side effects; SQLite, request fencing,
// reconciliation, restart and revocation are the production implementation.
type agentTeamsRemoteFixture struct {
	mu            sync.Mutex
	calls         []string
	task          agentteams.Task
	loseDelegate  bool
	readErr       error
	artifact      []byte
	artifactReads int
	allowDelivery bool
	lastSpec      string
}

func (f *agentTeamsRemoteFixture) Artifact(_ context.Context, _ agentteams.TaskBinding, _ string, _ string, _ int64) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.artifactReads++
	return append([]byte(nil), f.artifact...), nil
}

func (f *agentTeamsRemoteFixture) Call(_ context.Context, tool string, args map[string]any) (json.RawMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	action, _ := args["action"].(string)
	f.calls = append(f.calls, tool+"/"+action)
	if action == "create_task_room" {
		value, _ := json.Marshal(map[string]any{"ok": true, "roomId": "!original:example.test", "projectId": args["projectId"]})
		return value, nil
	}
	if action == "plan_dag" {
		tasks := args["tasks"].([]map[string]any)
		f.task = agentteams.Task{ProjectID: args["projectId"].(string), TaskID: tasks[0]["taskId"].(string), Status: "pending"}
	}
	if action == "delegate_task" {
		f.lastSpec, _ = args["spec"].(string)
		if args["assignedTo"] != "@executor:example.test" || args["roomId"] != "!original:example.test" || (!f.allowDelivery && args["spec"] != "Write the bounded result.") {
			return nil, errors.New("wrong fixed execution binding")
		}
		f.task.Status = "assigned"
		if f.loseDelegate {
			return nil, errors.New("response lost after assignment")
		}
	}
	return json.RawMessage(`{"ok":true}`), nil
}

func TestAgentTeamsExecutorDeliveryContractAndUnsupportedInputs(t *testing.T) {
	for _, files := range []bool{false, true} {
		t.Run(fmtBool(files), func(t *testing.T) {
			remote := &agentTeamsRemoteFixture{allowDelivery: true}
			j, e, r := agentTeamsFixture(t, t.TempDir(), remote)
			defer j.Close()
			payload := map[string]any{"spec": "Write the bounded result.", "pocketctl_delivery": true}
			if files {
				payload["inputs"] = []AgentTeamsInputFile{{Path: "files/proof.md", SHA256: externalPayloadDigest([]byte("proof")), Data: []byte("proof")}}
			}
			r.Input, _ = json.Marshal(payload)
			r.InputDigest = externalPayloadDigest(r.Input)
			_, err := e.Submit(context.Background(), r)
			if files {
				if !errors.Is(err, ErrExternalCapability) || len(remote.calls) != 0 {
					t.Fatal("frozen bytes silently discarded")
				}
				if _, _, err = j.Load(context.Background(), r.Identity.CallID); !errors.Is(err, ErrExternalMissing) {
					t.Fatal("unsupported input persisted as dispatched")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(remote.lastSpec, "shared/tasks/"+e.binding(r.Identity).TaskID+"/pocketctl-delivery/") || !strings.Contains(remote.lastSpec, "never claim trusted CI/review or human acceptance") {
					t.Fatal("remote delivery contract missing")
				}
			}
		})
	}
}

func fmtBool(value bool) string {
	if value {
		return "with-inputs"
	}
	return "delivery-only"
}
func (f *agentTeamsRemoteFixture) Task(_ context.Context, b agentteams.TaskBinding) (agentteams.Task, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.readErr != nil {
		return agentteams.Task{}, f.readErr
	}
	if f.task.ProjectID != b.ProjectID || f.task.TaskID != b.TaskID || b.TeamID != "fixed-team" {
		return agentteams.Task{}, &agentteams.HTTPError{Status: 404}
	}
	return f.task, nil
}
func (f *agentTeamsRemoteFixture) Cancel(_ context.Context, b agentteams.TaskBinding, sub, reason string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "cancel")
	return errors.New("runtime stop not confirmed")
}
func agentTeamsFixture(t *testing.T, root string, f *agentTeamsRemoteFixture) (*ExternalJournal, *AgentTeamsExecutor, ExternalExecutionRequest) {
	t.Helper()
	r, _ := externalRequestFixture()
	r.Input = []byte(`{"spec":"Write the bounded result."}`)
	r.InputDigest = externalPayloadDigest(r.Input)
	j, err := OpenExternalJournal(root, r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	e, err := NewAgentTeamsExecutor(j, AgentTeamsExecutorConfig{TeamID: "fixed-team", TeamRoomID: "!team:example.test", WorkerMatrixID: "@executor:example.test"}, f, f)
	if err != nil {
		j.Close()
		t.Fatal(err)
	}
	return j, e, r
}
func TestAgentTeamsExecutorLostSubmitResponseRestartDoesNotDelegateTwice(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	f := &agentTeamsRemoteFixture{loseDelegate: true}
	j, e, r := agentTeamsFixture(t, root, f)
	if _, err := e.Submit(ctx, r); !errors.Is(err, ErrExternalUnknown) {
		t.Fatal("lost response was not unknown", err)
	}
	j.Close()
	j, e, _ = agentTeamsFixture(t, root, f)
	defer j.Close()
	receipt, err := e.Submit(ctx, r)
	if err != nil || receipt.State != ExternalPending || receipt.Identity != r.Identity {
		t.Fatal(receipt, err)
	}
	if len(f.calls) != 4 {
		t.Fatal("restarted submit repeated upstream mutation", f.calls)
	}
	f.mu.Lock()
	f.task.Status = "in_progress"
	f.mu.Unlock()
	running, err := e.Lookup(ctx, r.Identity)
	if err != nil || running.State != ExternalRunning || running.Sequence <= receipt.Sequence {
		t.Fatal(running, err)
	}
	duplicate, err := e.Lookup(ctx, r.Identity)
	if err != nil || duplicate.Sequence != running.Sequence {
		t.Fatal("read inflated receipt version", duplicate, err)
	}
	f.mu.Lock()
	f.task.Status = "submitted"
	f.task.ResultStatus = "SUCCESS"
	f.task.SubmissionID = "original-submission"
	f.mu.Unlock()
	done, err := e.Lookup(ctx, r.Identity)
	if err != nil || done.State != ExternalSucceeded {
		t.Fatal(done, err)
	}
	f.mu.Lock()
	f.task.Status = "in_progress"
	f.mu.Unlock()
	if _, err = e.Lookup(ctx, r.Identity); !errors.Is(err, ErrExternalReceipt) {
		t.Fatal("remote terminal regression accepted", err)
	}
}
func TestAgentTeamsExecutorConcurrentHandlesSubmitOneAssignment(t *testing.T) {
	root := t.TempDir()
	f := &agentTeamsRemoteFixture{}
	j, a, r := agentTeamsFixture(t, root, f)
	defer j.Close()
	j2, b, _ := agentTeamsFixture(t, root, f)
	defer j2.Close()
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			e := a
			if i%2 != 0 {
				e = b
			}
			_, err := e.Submit(context.Background(), r)
			if err != nil && !errors.Is(err, ErrExternalUnknown) && !errors.Is(err, ErrExternalConflict) {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if len(f.calls) != 4 {
		t.Fatal("duplicate upstream mutations", f.calls)
	}
	if _, err := a.Lookup(context.Background(), r.Identity); err != nil {
		t.Fatal(err)
	}
}
func TestAgentTeamsExecutor404IsUnknownButMissingOriginalIsAuthoritative(t *testing.T) {
	j, e, r := agentTeamsFixture(t, t.TempDir(), &agentTeamsRemoteFixture{})
	defer j.Close()
	ctx := context.Background()
	if _, err := e.Lookup(ctx, r.Identity); !errors.Is(err, ErrExternalNotFound) {
		t.Fatal(err)
	}
	if err := j.SaveIntent(ctx, r); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Lookup(ctx, r.Identity); !errors.Is(err, ErrExternalUnknown) || errors.Is(err, ErrExternalNotFound) {
		t.Fatal("ordinary upstream 404 became retry authority", err)
	}
	changed := r
	changed.Identity.RequestID = "substituted"
	if _, err := e.Lookup(ctx, changed.Identity); !errors.Is(err, ErrExternalIdentity) {
		t.Fatal("request identity substitution", err)
	}
}
func TestAgentTeamsExecutorRevocationSurvivesFailedCancelAndRestart(t *testing.T) {
	root := t.TempDir()
	f := &agentTeamsRemoteFixture{}
	j, e, r := agentTeamsFixture(t, root, f)
	ctx := context.Background()
	if _, err := e.Submit(ctx, r); err != nil {
		t.Fatal(err)
	}
	if err := e.Cancel(ctx, r.Identity); err == nil {
		t.Fatal("unconfirmed runtime stop hidden")
	}
	j.Close()
	j, e, _ = agentTeamsFixture(t, root, f)
	defer j.Close()
	if _, err := e.Submit(ctx, r); !errors.Is(err, ErrExternalRevoked) {
		t.Fatal("revoked request resubmitted", err)
	}
	if _, err := e.Lookup(ctx, r.Identity); !errors.Is(err, ErrExternalRevoked) {
		t.Fatal("late result exposed", err)
	}
	if len(f.calls) != 5 {
		t.Fatal(f.calls)
	}
}
func TestAgentTeamsExecutorRejectsChangedInputAndHardCostBeforeEffects(t *testing.T) {
	f := &agentTeamsRemoteFixture{}
	j, e, r := agentTeamsFixture(t, t.TempDir(), f)
	defer j.Close()
	ctx := context.Background()
	cost := int64(1)
	r.MaxCostMicros = &cost
	if _, err := e.Submit(ctx, r); !errors.Is(err, ErrExternalCapability) {
		t.Fatal(err)
	}
	if len(f.calls) != 0 {
		t.Fatal("unsupported budget executed")
	}
	r.MaxCostMicros = nil
	if _, err := e.Submit(ctx, r); err != nil {
		t.Fatal(err)
	}
	r.Input = []byte(`{"spec":"different"}`)
	r.InputDigest = externalPayloadDigest(r.Input)
	if _, err := e.Submit(ctx, r); !errors.Is(err, ErrExternalConflict) {
		t.Fatal("frozen bytes changed", err)
	}
	if len(f.calls) != 4 {
		t.Fatal(f.calls)
	}
}

func TestAgentTeamsJournalRequiresExplicitInitializationAndSurvivesStoreLossClosed(t *testing.T) {
	root := t.TempDir()
	scope := "isolated-installation"
	if _, err := OpenAgentTeamsJournal(root, scope, "install-1"); err == nil {
		t.Fatal("opening missing journal silently initialized it")
	}
	j, err := InitializeAgentTeamsJournal(root, scope, "install-1")
	if err != nil {
		t.Fatal(err)
	}
	j.Close()
	if _, err = OpenAgentTeamsJournal(root, scope, "wrong-installation"); err == nil {
		t.Fatal("installation substitution accepted")
	}
	j, err = OpenAgentTeamsJournal(root, scope, "install-1")
	if err != nil {
		t.Fatal(err)
	}
	j.Close()
	files, err := filepath.Glob(filepath.Join(root, "*", "external-executions.db"))
	if err != nil || len(files) != 1 {
		t.Fatal(files, err)
	}
	if err = os.Remove(files[0]); err != nil {
		t.Fatal(err)
	}
	if _, err = OpenAgentTeamsJournal(root, scope, "install-1"); err == nil {
		t.Fatal("lost journal became authoritative empty store")
	}
	if _, err = os.Stat(files[0]); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed open recreated database", err)
	}
	if _, err = InitializeAgentTeamsJournal(root, scope, "install-1"); err == nil {
		t.Fatal("existing installation marker allowed journal reset")
	}
}

func TestAgentTeamsArtifactIsFrozenAndRevocationPreventsCachedExport(t *testing.T) {
	f := &agentTeamsRemoteFixture{artifact: []byte("original\n")}
	j, e, r := agentTeamsFixture(t, t.TempDir(), f)
	defer j.Close()
	ctx := context.Background()
	if _, err := e.Submit(ctx, r); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.task.Status = "submitted"
	f.task.ResultStatus = "SUCCESS"
	f.task.SubmissionID = "sub-original"
	f.mu.Unlock()
	path := "shared/tasks/" + e.binding(r.Identity).TaskID + "/result.md"
	first, err := e.ExportArtifact(ctx, r.Identity, path, 1024)
	if err != nil || string(first.Data) != "original\n" || first.SubmissionID != "sub-original" {
		t.Fatal(first, err)
	}
	f.mu.Lock()
	f.artifact = []byte("rewritten\n")
	f.mu.Unlock()
	again, err := e.ExportArtifact(ctx, r.Identity, path, 1024)
	if err != nil || string(again.Data) != "original\n" || again.SHA256 != first.SHA256 || f.artifactReads != 1 {
		t.Fatal("snapshot changed", again, err)
	}
	if _, err = e.ExportArtifact(ctx, r.Identity, path, 2); err == nil {
		t.Fatal("cached artifact bypassed caller size bound")
	}
	if err = j.revoke(ctx, r.Identity.CallID); err != nil {
		t.Fatal(err)
	}
	if data, err := e.ExportArtifact(ctx, r.Identity, path, 1024); !errors.Is(err, ErrExternalRevoked) || len(data.Data) != 0 {
		t.Fatal("cached artifact bypassed revocation", err)
	}
}

func TestAgentTeamsCancelBeforeSubmitFencesDelayedOriginal(t *testing.T) {
	f := &agentTeamsRemoteFixture{}
	j, e, r := agentTeamsFixture(t, t.TempDir(), f)
	defer j.Close()
	ctx := context.Background()
	if err := e.Cancel(ctx, r.Identity); err != nil {
		t.Fatal("cancel before arrival should persist a tombstone", err)
	}
	if _, err := e.Submit(ctx, r); !errors.Is(err, ErrExternalRevoked) {
		t.Fatal("delayed original escaped cancellation", err)
	}
	if len(f.calls) != 0 {
		t.Fatal("cancelled before arrival still delegated", f.calls)
	}
}

func TestAgentTeamsExistingTask404CannotAuthorizeOriginalRetry(t *testing.T) {
	f := &agentTeamsRemoteFixture{}
	j, e, r := agentTeamsFixture(t, t.TempDir(), f)
	defer j.Close()
	ctx := context.Background()
	if _, err := e.Submit(ctx, r); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.readErr = &agentteams.HTTPError{Status: 404}
	f.mu.Unlock()
	if _, err := e.Submit(ctx, r); !errors.Is(err, ErrExternalUnknown) || errors.Is(err, ErrExternalNotFound) {
		t.Fatal("upstream permission/missing ambiguity allowed retry", err)
	}
	if len(f.calls) != 4 {
		t.Fatal("404 repeated upstream mutations", f.calls)
	}
}

type agentTeamsDelayedDelegate struct {
	actual           AgentTeamsMCP
	entered, release chan struct{}
}

func (d *agentTeamsDelayedDelegate) Call(ctx context.Context, tool string, args map[string]any) (json.RawMessage, error) {
	if tool == "taskflow" && args["action"] == "delegate_task" {
		close(d.entered)
		<-d.release
	}
	return d.actual.Call(ctx, tool, args)
}
func TestAgentTeamsRevokeDuringDelegateRetriesCancellationAfterLateAssignment(t *testing.T) {
	f := &agentTeamsRemoteFixture{}
	j, e, r := agentTeamsFixture(t, t.TempDir(), f)
	defer j.Close()
	ctx := context.Background()
	d := &agentTeamsDelayedDelegate{actual: f, entered: make(chan struct{}), release: make(chan struct{})}
	e.mcp = d
	done := make(chan error, 1)
	go func() { _, err := e.Submit(ctx, r); done <- err }()
	<-d.entered
	if err := e.Cancel(ctx, r.Identity); err == nil {
		t.Fatal("runtime stop must remain unconfirmed")
	}
	close(d.release)
	if err := <-done; !errors.Is(err, ErrExternalRevoked) {
		t.Fatal("late result escaped cancellation", err)
	}
	count := 0
	for _, call := range f.calls {
		if call == "cancel" {
			count++
		}
	}
	if count != 2 {
		t.Fatal("late assignment did not trigger second exact-task cancellation", f.calls)
	}
}
