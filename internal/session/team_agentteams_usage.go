package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/pocketctl/pocketctl/internal/agentteams"
)

// AgentTeamsUsage contains only measured, normalized original Worker turns.
// Cost and hard cost enforcement remain unsupported.
type AgentTeamsUsage struct {
	Identity     ExternalExecutionIdentity
	RemoteTaskID string
	Usage        agentteams.WorkerUsage
}

// ConfigureWorker runs before serving requests. The endpoint is installation
// configuration and cannot change across restarts of the same journal.
func (e *AgentTeamsExecutor) ConfigureWorker(endpoint string, client *http.Client) error {
	worker, err := agentteams.NewWorkerClient(endpoint, client)
	if err != nil {
		return err
	}
	_, err = e.journal.db.Exec(`CREATE TABLE IF NOT EXISTS agentteams_worker_installation(scope TEXT PRIMARY KEY,endpoint TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS agentteams_usage(call_id TEXT PRIMARY KEY,value BLOB NOT NULL,digest TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS agentteams_stop_intents(call_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,chat_id TEXT NOT NULL,previous_finished_at TEXT NOT NULL,finished_at TEXT NOT NULL,confirmed INTEGER NOT NULL);`)
	if err != nil {
		return err
	}
	if _, err = e.journal.db.Exec(`INSERT INTO agentteams_worker_installation(scope,endpoint) VALUES(?,?) ON CONFLICT DO NOTHING`, e.journal.scope, endpoint); err != nil {
		return err
	}
	var saved string
	if err = e.journal.db.QueryRow(`SELECT endpoint FROM agentteams_worker_installation WHERE scope=?`, e.journal.scope).Scan(&saved); err != nil {
		return err
	}
	if saved != endpoint {
		return ErrExternalConflict
	}
	e.worker = worker
	return nil
}

func (e *AgentTeamsExecutor) Usage(ctx context.Context, id ExternalExecutionIdentity) (AgentTeamsUsage, error) {
	var empty AgentTeamsUsage
	_, receipt, err := e.original(ctx, id)
	if err != nil {
		return empty, err
	}
	if e.worker == nil {
		return empty, ErrExternalCapability
	}
	if receipt == nil || (receipt.State != ExternalSucceeded && receipt.State != ExternalFailed) {
		return empty, ErrExternalUnknown
	}
	binding := e.binding(id)
	if receipt.RemoteTaskID != binding.ProjectID+"/"+binding.TaskID {
		return empty, ErrExternalIdentity
	}
	load := func() (AgentTeamsUsage, error) {
		var raw []byte
		var digest string
		var value AgentTeamsUsage
		err := e.journal.db.QueryRowContext(ctx, `SELECT value,digest FROM agentteams_usage WHERE call_id=?`, id.CallID).Scan(&raw, &digest)
		if err != nil {
			return empty, err
		}
		if externalPayloadDigest(raw) != digest || json.Unmarshal(raw, &value) != nil || value.Identity != id || value.RemoteTaskID != receipt.RemoteTaskID {
			return empty, ErrExternalCorrupt
		}
		if err = e.allowed(ctx, id); err != nil {
			return empty, err
		}
		return value, nil
	}
	if cached, err := load(); !errors.Is(err, sql.ErrNoRows) {
		return cached, err
	}
	room, err := e.taskRoom(ctx, id)
	if err != nil {
		return empty, err
	}
	usage, err := e.worker.Usage(ctx, room)
	if err != nil {
		return empty, err
	}
	if err = e.allowed(ctx, id); err != nil {
		return empty, err
	}
	raw, err := json.Marshal(AgentTeamsUsage{id, receipt.RemoteTaskID, usage})
	if err != nil {
		return empty, err
	}
	if _, err = e.journal.db.ExecContext(ctx, `INSERT INTO agentteams_usage(call_id,value,digest) VALUES(?,?,?) ON CONFLICT DO NOTHING`, id.CallID, raw, externalPayloadDigest(raw)); err != nil {
		return empty, err
	}
	return load()
}

func (c *AgentTeamsBridgeClient) Usage(ctx context.Context, id ExternalExecutionIdentity) (AgentTeamsUsage, error) {
	var value AgentTeamsUsage
	if !id.valid() {
		return value, ErrExternalIdentity
	}
	err := c.request(ctx, "POST", "usage", id, &value, 512*1024)
	if err != nil {
		return AgentTeamsUsage{}, err
	}
	if value.Identity != id || !externalIdentifier(value.RemoteTaskID) || len(value.Usage.Turns) == 0 {
		return AgentTeamsUsage{}, ErrExternalIdentity
	}
	return value, nil
}

func (e *AgentTeamsExecutor) taskRoom(ctx context.Context, id ExternalExecutionIdentity) (string, error) {
	var raw []byte
	var digest string
	err := e.journal.db.QueryRowContext(ctx, `SELECT result,result_digest FROM agentteams_operations WHERE call_id=? AND step='room'`, id.CallID).Scan(&raw, &digest)
	if err != nil {
		return "", err
	}
	var room struct {
		OK        bool   `json:"ok"`
		ProjectID string `json:"projectId"`
		RoomID    string `json:"roomId"`
	}
	if externalPayloadDigest(raw) != digest || json.Unmarshal(raw, &room) != nil || !room.OK || room.ProjectID != e.binding(id).ProjectID || !agentTeamsMatrixID(room.RoomID, '!') {
		return "", ErrExternalCorrupt
	}
	return room.RoomID, nil
}
