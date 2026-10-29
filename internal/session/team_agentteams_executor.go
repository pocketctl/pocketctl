package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pocketctl/pocketctl/internal/agentteams"
)

// AgentTeamsMCP invokes the pinned upstream TeamHarness implementation under one
// installation's leader credentials. Tool names and execution targets are fixed
// here, never supplied by a model, template, or HTTP request.
type AgentTeamsMCP interface {
	Call(context.Context, string, map[string]any) (json.RawMessage, error)
}
type AgentTeamsTaskReader interface {
	Task(context.Context, agentteams.TaskBinding) (agentteams.Task, error)
	Cancel(context.Context, agentteams.TaskBinding, string, string) error
}
type AgentTeamsExecutorConfig struct {
	TeamID, TeamRoomID, WorkerMatrixID string
}
type AgentTeamsTaskInput struct {
	Spec     string `json:"spec"`
	Delivery bool   `json:"pocketctl_delivery,omitempty"`
}

// AgentTeamsExecutor is the bridge's durable submission boundary. Its journal
// is separate from the daemon's authorization journal. It never schedules,
// accepts results, retries notifications, or treats an upstream 404 as absence.
type AgentTeamsExecutor struct {
	journal *ExternalJournal
	config  AgentTeamsExecutorConfig
	mcp     AgentTeamsMCP
	reader  AgentTeamsTaskReader
	worker  *agentteams.WorkerClient
}

func NewAgentTeamsExecutor(j *ExternalJournal, config AgentTeamsExecutorConfig, mcp AgentTeamsMCP, reader AgentTeamsTaskReader) (*AgentTeamsExecutor, error) {
	if j == nil || mcp == nil || reader == nil || !agentTeamsMatrixID(config.TeamRoomID, '!') || !agentTeamsMatrixID(config.WorkerMatrixID, '@') || config.TeamID == "" || len(config.TeamID) > 128 || strings.ContainsAny(config.TeamID, "/\\\x00\r\n ") {
		return nil, ErrExternalIdentity
	}
	_, err := j.db.Exec(`CREATE TABLE IF NOT EXISTS agentteams_installation(scope TEXT PRIMARY KEY, config BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS agentteams_operations(call_id TEXT NOT NULL,step TEXT NOT NULL,arguments_digest TEXT NOT NULL,result BLOB,result_digest TEXT,PRIMARY KEY(call_id,step));`)
	if err != nil {
		return nil, err
	}
	_, err = j.db.Exec(`CREATE TABLE IF NOT EXISTS agentteams_artifacts(call_id TEXT NOT NULL,path TEXT NOT NULL,submission_id TEXT NOT NULL,sha256 TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(call_id,path));`)
	if err != nil {
		return nil, err
	}
	encoded, _ := json.Marshal(config)
	if _, err = j.db.Exec(`INSERT INTO agentteams_installation(scope,config) VALUES(?,?) ON CONFLICT DO NOTHING`, j.scope, encoded); err != nil {
		return nil, err
	}
	var saved []byte
	if err = j.db.QueryRow(`SELECT config FROM agentteams_installation WHERE scope=?`, j.scope).Scan(&saved); err != nil {
		return nil, err
	}
	if string(saved) != string(encoded) {
		return nil, ErrExternalConflict
	}
	return &AgentTeamsExecutor{journal: j, config: config, mcp: mcp, reader: reader}, nil
}

type AgentTeamsArtifact struct {
	Path         string
	SubmissionID string
	SHA256       string
	Data         []byte
}
type agentTeamsArtifactReader interface {
	Artifact(context.Context, agentteams.TaskBinding, string, string, int64) ([]byte, error)
}

// ExportArtifact durably freezes actual source bytes before returning them. The
// daemon must still recheck its Relay grant before importing/publishing a file.
func (e *AgentTeamsExecutor) ExportArtifact(ctx context.Context, id ExternalExecutionIdentity, path string, maxBytes int64) (AgentTeamsArtifact, error) {
	if maxBytes <= 0 || maxBytes > agentteams.MaxArtifactBytes {
		return AgentTeamsArtifact{}, agentteams.ErrArtifact
	}
	if err := e.allowed(ctx, id); err != nil {
		return AgentTeamsArtifact{}, err
	}
	b := e.binding(id)
	if !utf8.ValidString(path) || len(path) > 4096 || strings.Contains(path, "..") || strings.ContainsAny(path, "\\\r\n\x00") || !(strings.HasPrefix(path, "shared/tasks/"+b.TaskID+"/") || strings.HasPrefix(path, "shared/projects/"+b.ProjectID+"/")) {
		return AgentTeamsArtifact{}, agentteams.ErrArtifact
	}
	receipt, err := e.Lookup(ctx, id)
	if err != nil {
		return AgentTeamsArtifact{}, err
	}
	if receipt.State != ExternalSucceeded || receipt.RemoteSubmissionID == "" {
		return AgentTeamsArtifact{}, agentteams.ErrArtifact
	}
	load := func() (AgentTeamsArtifact, error) {
		var a AgentTeamsArtifact
		a.Path = path
		err := e.journal.db.QueryRowContext(ctx, `SELECT submission_id,sha256,data FROM agentteams_artifacts WHERE call_id=? AND path=?`, id.CallID, path).Scan(&a.SubmissionID, &a.SHA256, &a.Data)
		if err != nil {
			return AgentTeamsArtifact{}, err
		}
		if a.SubmissionID != receipt.RemoteSubmissionID || int64(len(a.Data)) > maxBytes || externalPayloadDigest(a.Data) != a.SHA256 {
			return AgentTeamsArtifact{}, agentteams.ErrArtifact
		}
		if err = e.allowed(ctx, id); err != nil {
			return AgentTeamsArtifact{}, err
		}
		return a, nil
	}
	if cached, err := load(); !errors.Is(err, sql.ErrNoRows) {
		return cached, err
	}
	reader, ok := e.reader.(agentTeamsArtifactReader)
	if !ok {
		return AgentTeamsArtifact{}, ErrExternalCapability
	}
	data, err := reader.Artifact(ctx, b, receipt.RemoteSubmissionID, path, maxBytes)
	if err != nil {
		return AgentTeamsArtifact{}, err
	}
	if err = e.allowed(ctx, id); err != nil {
		return AgentTeamsArtifact{}, err
	}
	if int64(len(data)) > maxBytes {
		return AgentTeamsArtifact{}, agentteams.ErrArtifact
	}
	_, err = e.journal.db.ExecContext(ctx, `INSERT INTO agentteams_artifacts(call_id,path,submission_id,sha256,data)
SELECT ?,?,?,?,? WHERE (SELECT COALESCE(SUM(length(data)),0) FROM agentteams_artifacts WHERE call_id=?)+?<=? AND (SELECT COUNT(*) FROM agentteams_artifacts WHERE call_id=?)<64
ON CONFLICT DO NOTHING`, id.CallID, path, receipt.RemoteSubmissionID, externalPayloadDigest(data), data, id.CallID, len(data), agentteams.MaxArtifactBytes, id.CallID)
	if err != nil {
		return AgentTeamsArtifact{}, err
	}
	result, err := load()
	if errors.Is(err, sql.ErrNoRows) {
		return AgentTeamsArtifact{}, agentteams.ErrArtifact
	}
	return result, err
}
func agentTeamsMatrixID(s string, prefix byte) bool {
	return len(s) > 3 && len(s) <= 1024 && s[0] == prefix && strings.Contains(s, ":") && !strings.ContainsAny(s, "\x00\r\n ")
}
func (e *AgentTeamsExecutor) Capabilities(context.Context) (ExternalCapabilities, error) {
	_, exports := e.reader.(agentTeamsArtifactReader)
	inputs, ok := e.mcp.(interface{ SupportsFrozenInputs() bool })
	return ExternalCapabilities{IdempotentSubmit: true, LookupByRequest: true, Cancellation: true, ArtifactExport: exports, FrozenInputs: ok && inputs.SupportsFrozenInputs(), UsageReporting: e.worker != nil, ModelStop: e.worker != nil}, nil
}
func (e *AgentTeamsExecutor) binding(id ExternalExecutionIdentity) agentteams.TaskBinding {
	encoded, _ := json.Marshal(id)
	key := externalPayloadDigest(encoded)
	return agentteams.TaskBinding{ProjectID: "pctl-" + key[:32], TaskID: "pctl-" + key[:32] + "-01", TeamID: e.config.TeamID}
}
func (e *AgentTeamsExecutor) allowed(ctx context.Context, id ExternalExecutionIdentity) error {
	if !id.valid() || id.Scope != e.journal.scope {
		return ErrExternalIdentity
	}
	revoked, err := e.journal.revoked(ctx, id.CallID)
	if err != nil {
		return err
	}
	if revoked {
		return ErrExternalRevoked
	}
	return nil
}
func (e *AgentTeamsExecutor) original(ctx context.Context, id ExternalExecutionIdentity) (ExternalExecutionRequest, *ExternalExecutionReceipt, error) {
	if err := e.allowed(ctx, id); err != nil {
		return ExternalExecutionRequest{}, nil, err
	}
	r, receipt, err := e.journal.Load(ctx, id.CallID)
	if errors.Is(err, ErrExternalMissing) {
		return r, nil, ErrExternalNotFound
	}
	if err == nil && r.Identity != id {
		return r, nil, ErrExternalIdentity
	}
	return r, receipt, err
}
func (e *AgentTeamsExecutor) operation(ctx context.Context, r ExternalExecutionRequest, step, tool string, args map[string]any) (json.RawMessage, error) {
	if err := e.allowed(ctx, r.Identity); err != nil {
		return nil, err
	}
	encoded, _ := json.Marshal(struct {
		Tool      string
		Arguments map[string]any
	}{tool, args})
	result, err := e.journal.db.ExecContext(ctx, `INSERT INTO agentteams_operations(call_id,step,arguments_digest) VALUES(?,?,?) ON CONFLICT DO NOTHING`, r.Identity.CallID, step, externalPayloadDigest(encoded))
	if err != nil {
		return nil, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n != 1 {
		return nil, ErrExternalUnknown
	}
	if err = e.allowed(ctx, r.Identity); err != nil {
		return nil, err
	}
	value, remoteErr := e.mcp.Call(ctx, tool, args)
	// Keep refusals as evidence too; never re-invoke an uncertain operation.
	if len(value) > 0 && len(value) <= agentteams.MaxMetadataBytes && json.Valid(value) {
		_, err = e.journal.db.ExecContext(ctx, `UPDATE agentteams_operations SET result=?,result_digest=? WHERE call_id=? AND step=? AND result IS NULL`, []byte(value), externalPayloadDigest(value), r.Identity.CallID, step)
		if err != nil {
			return nil, err
		}
	}
	if err = e.allowed(ctx, r.Identity); err != nil {
		if errors.Is(err, ErrExternalRevoked) && step == "delegate" {
			// A revoke may have cancelled before assignment became visible.
			// Reconcile cancellation against this exact original task once more.
			cancelCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
			_ = e.Cancel(cancelCtx, r.Identity)
			cancel()
		}
		return nil, err
	}
	var frame struct {
		OK bool `json:"ok"`
	}
	if remoteErr != nil || len(value) > agentteams.MaxMetadataBytes || json.Unmarshal(value, &frame) != nil || !frame.OK {
		return nil, ErrExternalUnknown
	}
	return value, nil
}
func (e *AgentTeamsExecutor) Submit(ctx context.Context, r ExternalExecutionRequest) (ExternalExecutionReceipt, error) {
	r = cloneExternalRequest(r)
	if err := e.allowed(ctx, r.Identity); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	caps, _ := e.Capabilities(ctx)
	if err := r.Validate(caps); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	var input AgentTeamsTaskInput
	if !utf8.Valid(r.Input) || json.Unmarshal(r.Input, &input) != nil || strings.TrimSpace(input.Spec) == "" || len(input.Spec) > 512*1024 {
		return ExternalExecutionReceipt{}, ErrExternalIdentity
	}
	var envelope struct {
		Inputs []AgentTeamsInputFile `json:"inputs"`
	}
	if json.Unmarshal(r.Input, &envelope) != nil {
		return ExternalExecutionReceipt{}, ErrExternalIdentity
	}
	// File transfer is a separate capability. Never silently execute a request
	// after dropping frozen predecessor bytes supplied by a newer daemon.
	if len(envelope.Inputs) > 0 {
		if !caps.FrozenInputs {
			return ExternalExecutionReceipt{}, ErrExternalCapability
		}
		if err := agentteams.ValidateInputFiles(envelope.Inputs); err != nil {
			return ExternalExecutionReceipt{}, ErrExternalIdentity
		}
	}
	if err := e.journal.SaveIntent(ctx, r); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	claimed, err := e.journal.claimSubmission(ctx, r.Identity.CallID)
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	if !claimed {
		return e.Lookup(ctx, r.Identity)
	}
	b := e.binding(r.Identity)
	spec := input.Spec
	if input.Delivery {
		spec += "\n\n[PocketCtl delivery contract]\nWrite the final delivery to shared/tasks/" + b.TaskID + "/pocketctl-delivery/. Create submission.json (UTF-8 without BOM) with schema_version=1, publish_scope=team, summary, artifacts=[{id,path,mime_type,required}], evidence=[] and contribution_ids=[]. Artifact paths are relative to this directory, never absolute or containing '..'. Include at least one actual artifact, at most 16, each at most 2 MiB. Declare submission.json AND every artifact as deliverables in your taskflow submission. Use only agent_claim evidence; never claim trusted CI/review or human acceptance. Report SUCCESS only after these files exist. The delivery directory and this contract supersede any daemon-local output path mentioned above.\n"
	}
	if _, err = e.operation(ctx, r, "project", "projectflow", map[string]any{"action": "create_project", "projectId": b.ProjectID, "title": "PocketCtl " + r.Identity.CallID, "teamId": b.TeamID, "source": "pocketctl", "sourceRoomId": e.config.TeamRoomID}); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	room, err := e.operation(ctx, r, "room", "roomflow", map[string]any{"action": "create_task_room", "projectId": b.ProjectID, "invite": []string{e.config.WorkerMatrixID}, "source": "pocketctl"})
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	var roomResult struct {
		RoomID string `json:"roomId"`
	}
	if json.Unmarshal(room, &roomResult) != nil || !agentTeamsMatrixID(roomResult.RoomID, '!') {
		return ExternalExecutionReceipt{}, ErrExternalUnknown
	}
	if _, err = e.operation(ctx, r, "plan", "projectflow", map[string]any{"action": "plan_dag", "projectId": b.ProjectID, "tasks": []map[string]any{{"taskId": b.TaskID, "title": "PocketCtl bounded execution", "assignedTo": e.config.WorkerMatrixID, "dependsOn": []string{}}}}); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	if len(envelope.Inputs) > 0 {
		if _, err = e.operation(ctx, r, "inputs", "pocketctl_inputs", map[string]any{"action": "upload_inputs", "projectId": b.ProjectID, "taskId": b.TaskID, "files": envelope.Inputs}); err != nil {
			return ExternalExecutionReceipt{}, err
		}
		spec += "\n\n[PocketCtl frozen predecessor inputs]\nBefore working, use filesync pull on shared/tasks/" + b.TaskID + "/pocketctl-inputs/ and read pocketctl-inputs/inputs.json. This exact read-only index contains original source versions, file hashes and task context. All file paths in that index are relative to its pocketctl-inputs directory. These remote files replace any daemon-local .pocketctl-inputs paths mentioned above; do not use a latest submission or substitute other source bytes.\n"
	}
	if _, err = e.operation(ctx, r, "delegate", "taskflow", map[string]any{"action": "delegate_task", "projectId": b.ProjectID, "taskId": b.TaskID, "roomId": roomResult.RoomID, "assignedTo": e.config.WorkerMatrixID, "spec": spec}); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	return e.Lookup(ctx, r.Identity)
}
func (e *AgentTeamsExecutor) Lookup(ctx context.Context, id ExternalExecutionIdentity) (ExternalExecutionReceipt, error) {
	r, current, err := e.original(ctx, id)
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	var digest string
	err = e.journal.db.QueryRowContext(ctx, `SELECT arguments_digest FROM agentteams_operations WHERE call_id=? AND step='delegate'`, id.CallID).Scan(&digest)
	if errors.Is(err, sql.ErrNoRows) {
		return ExternalExecutionReceipt{}, ErrExternalUnknown
	}
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	b := e.binding(id)
	task, err := e.reader.Task(ctx, b)
	if allowedErr := e.allowed(ctx, id); allowedErr != nil {
		return ExternalExecutionReceipt{}, allowedErr
	}
	if err != nil {
		return ExternalExecutionReceipt{}, errors.Join(ErrExternalUnknown, err)
	}
	if task.ProjectID != b.ProjectID || task.TaskID != b.TaskID {
		return ExternalExecutionReceipt{}, ErrExternalIdentity
	}
	var state ExternalExecutionState
	switch task.Status {
	case "assigned":
		state = ExternalPending
	case "in_progress":
		state = ExternalRunning
	case "submitted", "completed":
		if task.SubmissionID == "" {
			return ExternalExecutionReceipt{}, ErrExternalUnknown
		}
		switch task.ResultStatus {
		case "SUCCESS":
			state = ExternalSucceeded
		case "FAILED", "BLOCKED", "PARTIAL":
			state = ExternalFailed
		default:
			return ExternalExecutionReceipt{}, ErrExternalUnknown
		}
	// A remote cancellation alone does not prove the model has stopped.
	default:
		return ExternalExecutionReceipt{}, ErrExternalUnknown
	}
	next := ExternalExecutionReceipt{Identity: id, InputDigest: r.InputDigest, RemoteTaskID: b.ProjectID + "/" + b.TaskID, RemoteSubmissionID: task.SubmissionID, Sequence: 1, State: state}
	if current != nil {
		next.Sequence = current.Sequence
		if next.State != current.State || next.RemoteSubmissionID != current.RemoteSubmissionID {
			next.Sequence++
		}
	}
	stored, err := e.journal.RecordReceipt(ctx, next)
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	if err = e.allowed(ctx, id); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	return stored, nil
}
func (e *AgentTeamsExecutor) Cancel(ctx context.Context, id ExternalExecutionIdentity) error {
	// Repeated cancellation is permitted after the durable tombstone.
	if !id.valid() || id.Scope != e.journal.scope {
		return ErrExternalIdentity
	}
	r, _, err := e.journal.Load(ctx, id.CallID)
	if errors.Is(err, ErrExternalMissing) {
		// Cancellation can overtake a delayed Submit on the network. Fence the
		// Call even before its intent arrives; absence is not a reason to drop it.
		return e.journal.revoke(ctx, id.CallID)
	}
	if err != nil {
		return err
	}
	if r.Identity != id {
		return ErrExternalIdentity
	}
	if err = e.journal.revoke(ctx, id.CallID); err != nil {
		return err
	}
	b := e.binding(id)
	task, logicalErr := e.reader.Task(ctx, b)
	if logicalErr == nil {
		if task.TaskID != b.TaskID || task.ProjectID != b.ProjectID {
			return ErrExternalIdentity
		}
		logicalErr = e.reader.Cancel(ctx, b, task.SubmissionID, "PocketCtl authorization revoked or execution cancelled")
	}
	// Attempt the exact Worker stop even if the Controller is unavailable.
	// Both the durable task cancellation and tracker stop must be confirmed.
	stopErr := e.confirmWorkerStop(ctx, id)
	if logicalErr != nil || stopErr != nil {
		return errors.Join(ErrExternalUnknown, logicalErr, stopErr)
	}
	return nil
}
