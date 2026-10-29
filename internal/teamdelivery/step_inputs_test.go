package teamdelivery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func stepInputFixture(t *testing.T, mutate func(*StepInputManifest), corrupt, revoke bool) (*Client, *protocol.CollaborationAuthorization, string, []byte, *int) {
	t.Helper()
	auth := fixtureJob().Authorization
	auth.Delivery.AttemptID = testAttemptID
	bytes := []byte("exact frozen upstream bytes\n")
	source := StepInputSource{StepID: "upstream", AttemptID: "b1234567-1234-4234-8234-123456789abc", SubmissionID: testSubmissionID, Artifacts: []protocol.TeamDeliveryArtifact{{ID: "proof", Name: "../untrusted-name", MIMEType: "text/plain", ByteSize: len(bytes), SHA256: inputDigest(bytes), Required: true}}}
	data, _ := json.Marshal([]StepInputSource{source})
	hash := inputDigest(data)
	manifest := StepInputManifest{SchemaVersion: 1, CallID: auth.CallID, TaskID: auth.Delivery.TaskID, AttemptID: auth.Delivery.AttemptID, SpecRevision: auth.Delivery.SpecRevision, InputHash: hash, InputsJSON: string(data)}
	if mutate != nil {
		mutate(&manifest)
	}
	reads := 0
	manifestReads := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer fixture-token" {
			t.Errorf("unexpected request %s", r.Method)
			w.WriteHeader(403)
			return
		}
		if r.URL.Path == stepInputPath(&auth) {
			manifestReads++
			if revoke && manifestReads > 1 {
				w.WriteHeader(403)
				return
			}
			encoder := json.NewEncoder(w)
			encoder.SetEscapeHTML(false)
			_ = encoder.Encode(manifest)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/artifacts/proof") {
			reads++
			if corrupt {
				_, _ = w.Write([]byte("changed"))
			} else {
				_, _ = w.Write(bytes)
			}
			return
		}
		w.WriteHeader(404)
	}))
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL, func() string { return "fixture-token" }, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return client, &auth, hash, bytes, &reads
}

func TestStepInputHTTPMaterializationAndReauthorization(t *testing.T) {
	client, auth, hash, bytes, reads := stepInputFixture(t, nil, false, false)
	workspace := t.TempDir()
	if err := MaterializeStepInputs(context.Background(), client, auth, hash, workspace); err != nil {
		t.Fatal(err)
	}
	final := filepath.Join(workspace, ".pocketctl-inputs", inputDigest([]byte(auth.CallID)))
	metadata, err := os.ReadFile(filepath.Join(final, "inputs.json"))
	if err != nil {
		t.Fatal(err)
	}
	var local struct {
		Files     []inputFile `json:"files"`
		InputHash string      `json:"input_hash"`
	}
	if json.Unmarshal(metadata, &local) != nil || local.InputHash != hash || len(local.Files) != 1 {
		t.Fatalf("bad local manifest: %s", metadata)
	}
	file := filepath.Join(final, filepath.FromSlash(local.Files[0].Path))
	got, err := os.ReadFile(file)
	if err != nil || string(got) != string(bytes) {
		t.Fatalf("file mismatch: %v", err)
	}
	if _, err = os.Stat(filepath.Join(workspace, "untrusted-name")); !os.IsNotExist(err) {
		t.Fatal("source name became a path")
	}
	if err = MaterializeStepInputs(context.Background(), client, auth, hash, workspace); err != nil {
		t.Fatal(err)
	}
	if *reads != 2 {
		t.Fatal("existing files bypassed Relay reauthorization")
	}
	if err = os.Chmod(file, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(file, []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = MaterializeStepInputs(context.Background(), client, auth, hash, workspace); err == nil {
		t.Fatal("silently reused/overwrote altered input")
	}
	got, _ = os.ReadFile(file)
	if string(got) != "tampered" {
		t.Fatal("overwrote existing input")
	}
}

func TestStepInputFailureNeverPublishesLocalManifest(t *testing.T) {
	for _, kind := range []string{"corrupt", "revoked", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			client, auth, hash, _, _ := stepInputFixture(t, nil, kind == "corrupt", kind == "revoked")
			workspace := t.TempDir()
			outside := t.TempDir()
			if kind == "symlink" {
				if err := os.Symlink(outside, filepath.Join(workspace, ".pocketctl-inputs")); err != nil {
					t.Fatal(err)
				}
			}
			if err := MaterializeStepInputs(context.Background(), client, auth, hash, workspace); err == nil {
				t.Fatal("unsafe input accepted")
			}
			entries, _ := os.ReadDir(outside)
			if len(entries) != 0 {
				t.Fatal("escaped workspace")
			}
			if kind != "symlink" {
				entries, _ = os.ReadDir(filepath.Join(workspace, ".pocketctl-inputs"))
				if len(entries) != 0 {
					t.Fatal("partial input became visible or staging leaked")
				}
			}
		})
	}
}

func TestStepInputManifestBindingRejectsBeforeFileDownload(t *testing.T) {
	for _, kind := range []string{"call", "attempt", "spec", "hash", "json"} {
		t.Run(kind, func(t *testing.T) {
			client, auth, hash, _, reads := stepInputFixture(t, func(m *StepInputManifest) {
				switch kind {
				case "call":
					m.CallID = "other"
				case "attempt":
					m.AttemptID = "b1234567-1234-4234-8234-123456789abc"
				case "spec":
					m.SpecRevision++
				case "hash":
					m.InputHash = strings.Repeat("0", 64)
				case "json":
					m.InputsJSON = "[]"
				}
			}, false, false)
			if err := MaterializeStepInputs(context.Background(), client, auth, hash, t.TempDir()); err == nil {
				t.Fatal("mismatched manifest accepted")
			}
			if *reads != 0 {
				t.Fatal("downloaded before binding validation")
			}
		})
	}
}

func TestStepInputHTMLRichMetadataRemainsReusable(t *testing.T) {
	var expected string
	client, auth, _, _, _ := stepInputFixture(t, func(m *StepInputManifest) {
		var inputs []map[string]any
		if err := json.Unmarshal([]byte(m.InputsJSON), &inputs); err != nil {
			t.Fatal(err)
		}
		// Exercise raw canonical metadata escaping independently of its typed
		// projection; the authoritative source JSON must survive byte-for-byte.
		inputs[0]["provenance_notes"] = strings.Repeat("<>&", 32000)
		var buf strings.Builder
		encoder := json.NewEncoder(&buf)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(inputs); err != nil {
			t.Fatal(err)
		}
		m.InputsJSON = strings.TrimSuffix(buf.String(), "\n")
		m.InputHash = inputDigest([]byte(m.InputsJSON))
		expected = m.InputHash
	}, false, false)
	workspace := t.TempDir()
	for i := 0; i < 2; i++ {
		if err := MaterializeStepInputs(context.Background(), client, auth, expected, workspace); err != nil {
			t.Fatalf("materialization %d: %v", i, err)
		}
	}
	data, err := os.ReadFile(filepath.Join(workspace, ".pocketctl-inputs", inputDigest([]byte(auth.CallID)), "inputs.json"))
	if err != nil || len(data) > maxStepInputWireBytes {
		t.Fatal("local metadata exceeds readable limit")
	}
}

func TestIsolatedRelayStepInputHTTP(t *testing.T) {
	if os.Getenv("TEAM_STEP_INPUT_RELAY_INTEGRATION") != "1" {
		t.Skip("requires dedicated loopback input Relay fixture")
	}
	data, err := os.ReadFile(os.Getenv("TEAM_STEP_INPUT_FIXTURE"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		URL           string                              `json:"url"`
		Authorization protocol.CollaborationAuthorization `json:"authorization"`
		Context       protocol.CollaborationContext       `json:"context"`
		AuthorToken   string                              `json:"author_token"`
		SHA256        string                              `json:"artifact_sha256"`
	}
	if json.Unmarshal(data, &fixture) != nil || fixture.URL != "http://127.0.0.1:18994" {
		t.Fatal("dedicated loopback fixture required")
	}
	client, err := NewClient(fixture.URL, func() string { return fixture.AuthorToken }, nil)
	if err != nil {
		t.Fatal(err)
	}
	workspace := t.TempDir()
	for i := 0; i < 3; i++ {
		if err = MaterializeStepInputs(context.Background(), client, &fixture.Authorization, fixture.Context.StepInputHash, workspace); err != nil {
			t.Fatalf("real HTTP input round %d: %v", i, err)
		}
	}
	metadata, err := os.ReadFile(filepath.Join(workspace, ".pocketctl-inputs", inputDigest([]byte(fixture.Authorization.CallID)), "inputs.json"))
	if err != nil {
		t.Fatal(err)
	}
	var local struct {
		Files     []inputFile `json:"files"`
		InputHash string      `json:"input_hash"`
	}
	if json.Unmarshal(metadata, &local) != nil || len(local.Files) != 1 || local.InputHash != fixture.Context.StepInputHash {
		t.Fatal("local snapshot mismatch")
	}
	bytes, err := os.ReadFile(filepath.Join(workspace, ".pocketctl-inputs", inputDigest([]byte(fixture.Authorization.CallID)), filepath.FromSlash(local.Files[0].Path)))
	if err != nil || inputDigest(bytes) != fixture.SHA256 {
		t.Fatal("real source bytes mismatch")
	}
	var resolved struct {
		TaskContext struct {
			TaskID      string `json:"task_id"`
			CallID      string `json:"call_id"`
			AttemptID   string `json:"attempt_id"`
			Instruction string `json:"instruction"`
		} `json:"task_context"`
	}
	if json.Unmarshal(metadata, &resolved) != nil || resolved.TaskContext.TaskID != fixture.Authorization.Delivery.TaskID || resolved.TaskContext.CallID != fixture.Authorization.CallID || resolved.TaskContext.AttemptID != fixture.Authorization.Delivery.AttemptID || resolved.TaskContext.Instruction == "" {
		t.Fatal("real HTTP task context missing or incorrectly bound")
	}
	t.Logf("three read/materialize rounds; call=%s input_hash=%s artifact_sha256=%s bytes=%d", fixture.Authorization.CallID, local.InputHash, fixture.SHA256, len(bytes))
}

func TestStepTaskContextMaterializesOnlyExactAuthorizedSnapshot(t *testing.T) {
	for _, invalid := range []string{"", "call", "task", "attempt", "spec", "hash", "writable", "json", "limit"} {
		t.Run(invalid, func(t *testing.T) {
			client, auth, hash, _, reads := stepInputFixture(t, func(m *StepInputManifest) {
				value := map[string]any{"schema_version": 1, "read_only": true, "call_id": m.CallID, "task_id": m.TaskID, "attempt_id": m.AttemptID, "spec_revision": m.SpecRevision, "input_hash": m.InputHash, "instruction": "Resolve this exact task <reference>"}
				switch invalid {
				case "call":
					value["call_id"] = "other"
				case "task":
					value["task_id"] = "other"
				case "attempt":
					value["attempt_id"] = "other"
				case "spec":
					value["spec_revision"] = m.SpecRevision + 1
				case "hash":
					value["input_hash"] = strings.Repeat("0", 64)
				case "writable":
					value["read_only"] = false
				case "limit":
					value["instruction"] = strings.Repeat("a", maxStepInputCanonicalBytes)
				}
				data, _ := json.Marshal(value)
				m.TaskContextJSON = string(data)
				if invalid == "json" {
					m.TaskContextJSON = "{"
				}
			}, false, false)
			workspace := t.TempDir()
			err := MaterializeStepInputs(context.Background(), client, auth, hash, workspace)
			if invalid != "" {
				if err == nil || err.Error() != "step_task_context_binding_invalid" || *reads != 0 {
					t.Fatalf("invalid snapshot admitted: %v reads=%d", err, *reads)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(workspace, ".pocketctl-inputs", inputDigest([]byte(auth.CallID)), "inputs.json")
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var local struct {
				TaskContext struct {
					CallID      string `json:"call_id"`
					Instruction string `json:"instruction"`
				} `json:"task_context"`
			}
			if json.Unmarshal(data, &local) != nil || local.TaskContext.CallID != auth.CallID || local.TaskContext.Instruction != "Resolve this exact task <reference>" {
				t.Fatal("task context not preserved")
			}
			if err := MaterializeStepInputs(context.Background(), client, auth, hash, workspace); err != nil {
				t.Fatal(err)
			}
		})
	}
}

type legacyTaskContextAPI struct{ StepInputAPI }

func (api legacyTaskContextAPI) ReadStepInputManifest(ctx context.Context, auth *protocol.CollaborationAuthorization) (StepInputManifest, error) {
	manifest, err := api.StepInputAPI.ReadStepInputManifest(ctx, auth)
	manifest.TaskContextJSON = ""
	return manifest, err
}

func TestStepTaskContextUpgradePreservesVerifiedLegacyBytes(t *testing.T) {
	client, auth, hash, _, _ := stepInputFixture(t, func(m *StepInputManifest) {
		data, _ := json.Marshal(map[string]any{"schema_version": 1, "read_only": true, "call_id": m.CallID, "task_id": m.TaskID, "attempt_id": m.AttemptID, "spec_revision": m.SpecRevision, "input_hash": m.InputHash, "instruction": "original task context"})
		m.TaskContextJSON = string(data)
	}, false, false)
	workspace := t.TempDir()
	if err := MaterializeStepInputs(context.Background(), legacyTaskContextAPI{client}, auth, hash, workspace); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(workspace, ".pocketctl-inputs", inputDigest([]byte(auth.CallID)), "inputs.json")
	legacy, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(legacy), "task_context") {
		t.Fatal("not a legacy fixture")
	}
	if err := MaterializeStepInputs(context.Background(), client, auth, hash, workspace); err != nil {
		t.Fatal(err)
	}
	current, err := os.ReadFile(path)
	if err != nil || string(current) != string(legacy) {
		t.Fatal("legacy metadata was overwritten")
	}
	workspace = t.TempDir()
	if err := MaterializeStepInputs(context.Background(), client, auth, hash, workspace); err != nil {
		t.Fatal(err)
	}
	path = filepath.Join(workspace, ".pocketctl-inputs", inputDigest([]byte(auth.CallID)), "inputs.json")
	current, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	changed := strings.Replace(string(current), "original task context", "tampered task context", 1)
	if changed == string(current) {
		t.Fatal("fixture missing task context")
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(changed), 0400); err != nil {
		t.Fatal(err)
	}
	if err := MaterializeStepInputs(context.Background(), client, auth, hash, workspace); err == nil || err.Error() != "step_input_existing_changed" {
		t.Fatalf("changed existing context accepted: %v", err)
	}
}
