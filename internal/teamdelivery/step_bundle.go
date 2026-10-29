package teamdelivery

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/sessiondocument"
)

type FrozenStepFile struct {
	Path   string
	SHA256 string
	Data   []byte
}

// FreezeStepInputBundle reuses native materialization, then freezes exact bytes
// for remote transfer. A final authoritative read binds the local index and
// TaskContext back to the current original Call; local files grant no authority.
func FreezeStepInputBundle(ctx context.Context, api StepInputAPI, auth *protocol.CollaborationAuthorization, hash, workspace string) ([]FrozenStepFile, error) {
	if err := MaterializeStepInputs(ctx, api, auth, hash, workspace); err != nil {
		return nil, err
	}
	directory := ".pocketctl-inputs/" + inputDigest([]byte(auth.CallID))
	data, err := sessiondocument.ReadExplicitArtifact(workspace, directory+"/inputs.json", maxStepInputWireBytes)
	if err != nil {
		return nil, err
	}
	var local struct {
		SchemaVersion int             `json:"schema_version"`
		CallID        string          `json:"call_id"`
		AttemptID     string          `json:"attempt_id"`
		InputHash     string          `json:"input_hash"`
		Inputs        json.RawMessage `json:"inputs"`
		Files         []inputFile     `json:"files"`
		TaskContext   json.RawMessage `json:"task_context,omitempty"`
	}
	if json.Unmarshal(data, &local) != nil || local.SchemaVersion != 1 || local.CallID != auth.CallID || local.AttemptID != auth.Delivery.AttemptID || local.InputHash != hash || inputDigest(local.Inputs) != hash || len(local.Files) > 128 {
		return nil, fmt.Errorf("step_bundle_identity_invalid")
	}
	var sources []StepInputSource
	if json.Unmarshal(local.Inputs, &sources) != nil {
		return nil, fmt.Errorf("step_bundle_index_invalid")
	}
	result := []FrozenStepFile{{Path: "inputs.json", SHA256: inputDigest(data), Data: data}}
	index, total := 0, 0
	for _, source := range sources {
		for _, artifact := range source.Artifacts {
			key := source.AttemptID + "/" + source.SubmissionID + "/" + artifact.ID
			expected := inputFile{source.AttemptID, source.SubmissionID, artifact.ID, "files/" + inputDigest([]byte(key)), artifact.SHA256}
			if index >= len(local.Files) || local.Files[index] != expected {
				return nil, fmt.Errorf("step_bundle_file_binding_invalid")
			}
			bytes, err := sessiondocument.ReadExplicitArtifact(workspace, directory+"/"+expected.Path, MaxArtifactBytes)
			if err != nil || len(bytes) != artifact.ByteSize || inputDigest(bytes) != artifact.SHA256 {
				return nil, fmt.Errorf("step_bundle_integrity_invalid")
			}
			total += len(bytes)
			if total > maxStepInputBytes {
				return nil, fmt.Errorf("step_bundle_limit_exceeded")
			}
			result = append(result, FrozenStepFile{Path: expected.Path, SHA256: artifact.SHA256, Data: bytes})
			index++
		}
	}
	if index != len(local.Files) {
		return nil, fmt.Errorf("step_bundle_extra_files")
	}
	current, err := api.ReadStepInputManifest(ctx, auth)
	if err != nil {
		return nil, err
	}
	if current.SchemaVersion != 1 || current.CallID != auth.CallID || current.TaskID != auth.Delivery.TaskID || current.AttemptID != auth.Delivery.AttemptID || current.SpecRevision != auth.Delivery.SpecRevision || current.InputHash != hash || !bytes.Equal([]byte(current.InputsJSON), local.Inputs) || !bytes.Equal([]byte(current.TaskContextJSON), local.TaskContext) {
		return nil, fmt.Errorf("step_bundle_authority_changed")
	}
	return result, ctx.Err()
}
