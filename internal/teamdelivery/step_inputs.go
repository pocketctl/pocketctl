package teamdelivery

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/sessiondocument"
)

const maxStepInputWireBytes = 512 * 1024
const maxStepInputCanonicalBytes = 128 * 1024
const maxStepInputBytes = 64 * 1024 * 1024

type StepInputSource struct {
	StepID       string                          `json:"step_id"`
	AttemptID    string                          `json:"attempt_id"`
	SubmissionID string                          `json:"submission_id"`
	Artifacts    []protocol.TeamDeliveryArtifact `json:"artifacts"`
}

type StepInputManifest struct {
	SchemaVersion   int    `json:"schema_version"`
	CallID          string `json:"call_id"`
	TaskID          string `json:"task_id"`
	AttemptID       string `json:"attempt_id"`
	SpecRevision    int64  `json:"spec_revision"`
	InputHash       string `json:"input_hash"`
	InputsJSON      string `json:"inputs_json"`
	TaskContextJSON string `json:"task_context_json,omitempty"`
}

type StepInputAPI interface {
	ReadStepInputManifest(context.Context, *protocol.CollaborationAuthorization) (StepInputManifest, error)
	ReadStepInputArtifact(context.Context, *protocol.CollaborationAuthorization, StepInputSource, protocol.TeamDeliveryArtifact) ([]byte, error)
}

func inputDigest(data []byte) string { hash := sha256.Sum256(data); return hex.EncodeToString(hash[:]) }

func stepInputPath(auth *protocol.CollaborationAuthorization) string {
	return "/api/team/daemons/" + url.PathEscape(auth.DaemonID) + "/calls/" + url.PathEscape(auth.CallID) + "/step-inputs"
}

func (c *Client) readInputBytes(ctx context.Context, path string, limit int) ([]byte, error) {
	// Retry only explicit transient contention, within the same Call and the
	// materialization deadline. Never create another attempt or skip reauthorization.
	for attempt := 0; ; attempt++ {
		data, failure, retryable := c.readInputBytesOnce(ctx, path, limit)
		if !retryable || attempt == 3 {
			return data, failure
		}
		timer := time.NewTimer(time.Duration(1<<attempt) * 250 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func (c *Client) readInputBytesOnce(ctx context.Context, path string, limit int) ([]byte, error, bool) {
	token := c.token()
	if token == "" {
		return nil, &HTTPError{Status: 401, Code: "authorization_required"}, false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return nil, err, false
	}
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err(), false
		}
		return nil, fmt.Errorf("step_input_transport_unavailable"), false
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, int64(limit)+1))
	if err != nil || len(data) > limit {
		return nil, fmt.Errorf("step_input_response_invalid"), false
	}
	if response.StatusCode != http.StatusOK {
		var value struct {
			Error struct {
				Code      string `json:"code"`
				Retryable bool   `json:"retryable"`
			} `json:"error"`
		}
		validError := json.Unmarshal(data, &value) == nil
		code := value.Error.Code
		if !validError || !artifactID.MatchString(code) {
			code = "step_input_unavailable"
		}
		return nil, &HTTPError{Status: response.StatusCode, Code: code}, response.StatusCode == http.StatusServiceUnavailable && code == "source_busy" && value.Error.Retryable
	}
	return data, nil, false
}

func (c *Client) ReadStepInputManifest(ctx context.Context, auth *protocol.CollaborationAuthorization) (StepInputManifest, error) {
	var manifest StepInputManifest
	data, err := c.readInputBytes(ctx, stepInputPath(auth), maxStepInputWireBytes)
	if err != nil {
		return manifest, err
	}
	if json.Unmarshal(data, &manifest) != nil {
		return manifest, fmt.Errorf("step_input_manifest_invalid")
	}
	return manifest, nil
}

func (c *Client) ReadStepInputArtifact(ctx context.Context, auth *protocol.CollaborationAuthorization, source StepInputSource, artifact protocol.TeamDeliveryArtifact) ([]byte, error) {
	path := stepInputPath(auth) + "/" + url.PathEscape(source.AttemptID) + "/" + url.PathEscape(source.SubmissionID) + "/artifacts/" + url.PathEscape(artifact.ID)
	return c.readInputBytes(ctx, path, MaxArtifactBytes)
}

type inputFile struct {
	AttemptID    string `json:"attempt_id"`
	SubmissionID string `json:"submission_id"`
	ArtifactID   string `json:"artifact_id"`
	Path         string `json:"path"`
	SHA256       string `json:"sha256"`
}

// MaterializeStepInputs downloads exact, currently authorized sources before
// execution. It uses hash-derived local names, an in-root staging directory,
// and a final rename. Agent-supplied names never become filesystem paths.
// A repeated read always rechecks Relay authorization before reusing bytes.
func MaterializeStepInputs(ctx context.Context, api StepInputAPI, auth *protocol.CollaborationAuthorization, expectedHash, workspace string) error {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	if api == nil || auth == nil || auth.Delivery == nil || auth.Delivery.AttemptID == "" || !protocol.ValidTeamDeliveryAttemptID(auth.Delivery.AttemptID) || auth.CallID == "" || auth.DaemonID == "" || auth.Delivery.TaskID == "" || auth.Delivery.SpecRevision < 1 || !filepath.IsAbs(workspace) {
		return fmt.Errorf("step_input_authorization_invalid")
	}
	manifest, err := api.ReadStepInputManifest(ctx, auth)
	if err != nil {
		return err
	}
	if manifest.SchemaVersion != 1 || manifest.CallID != auth.CallID || manifest.TaskID != auth.Delivery.TaskID || manifest.AttemptID != auth.Delivery.AttemptID || manifest.SpecRevision != auth.Delivery.SpecRevision || len(manifest.InputsJSON) > maxStepInputCanonicalBytes || manifest.InputHash != expectedHash || inputDigest([]byte(manifest.InputsJSON)) != expectedHash {
		return fmt.Errorf("step_input_manifest_binding_invalid")
	}
	if manifest.TaskContextJSON != "" {
		var taskContext struct {
			SchemaVersion int    `json:"schema_version"`
			ReadOnly      bool   `json:"read_only"`
			TaskID        string `json:"task_id"`
			CallID        string `json:"call_id"`
			AttemptID     string `json:"attempt_id"`
			SpecRevision  int64  `json:"spec_revision"`
			InputHash     string `json:"input_hash"`
		}
		if len(manifest.TaskContextJSON) > maxStepInputCanonicalBytes || json.Unmarshal([]byte(manifest.TaskContextJSON), &taskContext) != nil || taskContext.SchemaVersion != 1 || !taskContext.ReadOnly || taskContext.TaskID != auth.Delivery.TaskID || taskContext.CallID != auth.CallID || taskContext.AttemptID != auth.Delivery.AttemptID || taskContext.SpecRevision != auth.Delivery.SpecRevision || taskContext.InputHash != expectedHash {
			return fmt.Errorf("step_task_context_binding_invalid")
		}
	}
	var sources []StepInputSource
	if json.Unmarshal([]byte(manifest.InputsJSON), &sources) != nil || sources == nil || len(sources) > 32 {
		return fmt.Errorf("step_input_snapshot_invalid")
	}
	files := []inputFile{}
	seen := map[string]bool{}
	total := 0
	for _, source := range sources {
		if !artifactID.MatchString(source.StepID) || source.AttemptID == "" || !protocol.ValidTeamDeliveryAttemptID(source.AttemptID) || source.SubmissionID == "" || !protocol.ValidTeamDeliveryAttemptID(source.SubmissionID) || len(source.Artifacts) > 16 {
			return fmt.Errorf("step_input_source_invalid")
		}
		for _, artifact := range source.Artifacts {
			key := source.AttemptID + "/" + source.SubmissionID + "/" + artifact.ID
			hashBytes, hashErr := hex.DecodeString(artifact.SHA256)
			if !artifactID.MatchString(artifact.ID) || seen[key] || artifact.ByteSize < 1 || artifact.ByteSize > MaxArtifactBytes || hashErr != nil || len(hashBytes) != 32 || strings.ToLower(artifact.SHA256) != artifact.SHA256 {
				return fmt.Errorf("step_input_artifact_invalid")
			}
			seen[key] = true
			total += artifact.ByteSize
			files = append(files, inputFile{source.AttemptID, source.SubmissionID, artifact.ID, "files/" + inputDigest([]byte(key)), artifact.SHA256})
		}
	}
	if len(files) > 128 || total > maxStepInputBytes {
		return fmt.Errorf("step_input_limit_exceeded")
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return err
	}
	defer root.Close()
	parent := ".pocketctl-inputs"
	if err = root.Mkdir(parent, 0700); err != nil && !os.IsExist(err) {
		return err
	}
	info, err := root.Lstat(parent)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("step_input_directory_invalid")
	}
	temporary := parent + "/staging-" + rand.Text()
	if err = root.Mkdir(temporary, 0700); err != nil {
		return err
	}
	defer root.RemoveAll(temporary)
	if err = root.Mkdir(temporary+"/files", 0700); err != nil {
		return err
	}
	write := func(name string, data []byte) error {
		file, err := root.OpenFile(temporary+"/"+name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0400)
		if err != nil {
			return err
		}
		_, err = file.Write(data)
		if err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err == nil {
			err = closeErr
		}
		return err
	}
	index := 0
	for _, source := range sources {
		for _, artifact := range source.Artifacts {
			data, err := api.ReadStepInputArtifact(ctx, auth, source, artifact)
			if err != nil {
				return err
			}
			if len(data) != artifact.ByteSize || inputDigest(data) != artifact.SHA256 {
				return fmt.Errorf("step_input_artifact_integrity")
			}
			if err = write(files[index].Path, data); err != nil {
				return err
			}
			index++
		}
	}
	// Close a revocation window between the first manifest and the final file.
	confirmed, err := api.ReadStepInputManifest(ctx, auth)
	if err != nil {
		return err
	}
	if confirmed != manifest {
		return fmt.Errorf("step_input_manifest_changed")
	}
	local := struct {
		SchemaVersion int             `json:"schema_version"`
		CallID        string          `json:"call_id"`
		AttemptID     string          `json:"attempt_id"`
		InputHash     string          `json:"input_hash"`
		Inputs        json.RawMessage `json:"inputs"`
		Files         []inputFile     `json:"files"`
		TaskContext   json.RawMessage `json:"task_context,omitempty"`
	}{1, auth.CallID, auth.Delivery.AttemptID, expectedHash, json.RawMessage(manifest.InputsJSON), files, json.RawMessage(manifest.TaskContextJSON)}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err = encoder.Encode(local); err != nil {
		return err
	}
	metadata := encoded.Bytes()
	if len(metadata) > maxStepInputWireBytes {
		return fmt.Errorf("step_input_local_manifest_limit")
	}
	if err = write("inputs.json", metadata); err != nil {
		return err
	}
	final := parent + "/" + inputDigest([]byte(auth.CallID))
	if info, err = root.Lstat(final); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("step_input_existing_invalid")
		}
		old, err := sessiondocument.ReadExplicitArtifact(workspace, final+"/inputs.json", maxStepInputWireBytes)
		if err != nil {
			return fmt.Errorf("step_input_existing_changed")
		}
		matches := bytes.Equal(old, metadata)
		if !matches && len(local.TaskContext) > 0 {
			// Earlier daemons wrote the same immutable file map without the
			// optional task context. Accept only those exact legacy bytes;
			// never overwrite existing metadata or accept a changed context.
			legacy := local
			legacy.TaskContext = nil
			var legacyBytes bytes.Buffer
			legacyEncoder := json.NewEncoder(&legacyBytes)
			legacyEncoder.SetEscapeHTML(false)
			if legacyEncoder.Encode(legacy) == nil {
				matches = bytes.Equal(old, legacyBytes.Bytes())
			}
		}
		if !matches {
			return fmt.Errorf("step_input_existing_changed")
		}
		for _, file := range files {
			data, err := sessiondocument.ReadExplicitArtifact(workspace, final+"/"+file.Path, MaxArtifactBytes)
			if err != nil || inputDigest(data) != file.SHA256 {
				return fmt.Errorf("step_input_existing_changed")
			}
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	return root.Rename(temporary, final)
}
