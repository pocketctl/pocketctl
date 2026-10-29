package agentteams

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// This is the actual pinned upstream control service, not a substitute for a
// remote Worker, artifact publication, dispatch authorization or D19 acceptance.
func pinnedDockerClient(t *testing.T) *Client {
	t.Helper()
	if os.Getenv("AGENTTEAMS_T17_ACCEPTANCE") != "1" {
		t.Skip("requires named isolated AgentTeams Docker probe")
	}
	output, err := exec.Command("docker", "inspect", "pocketctl-team-external-t17-controller-1").Output()
	if err != nil {
		t.Fatal("named upstream container unavailable")
	}
	var containers []struct {
		Image  string
		Config struct {
			Labels map[string]string
			Env    []string
		}
		HostConfig      struct{ Privileged bool }
		Mounts          []struct{ Type, Name string }
		NetworkSettings struct {
			Ports map[string][]struct{ HostIp string }
		}
	}
	if json.Unmarshal(output, &containers) != nil || len(containers) != 1 {
		t.Fatal("invalid deployment identity")
	}
	c := containers[0]
	if c.Config.Labels["com.docker.compose.project"] != "pocketctl-team-external-t17" || c.HostConfig.Privileged {
		t.Fatal("wrong deployment scope")
	}
	for _, m := range c.Mounts {
		if m.Type != "volume" || !strings.HasPrefix(m.Name, "pocketctl-team-external-t17_") {
			t.Fatal("unexpected host mount")
		}
	}
	for _, ports := range c.NetworkSettings.Ports {
		for _, p := range ports {
			if p.HostIp != "127.0.0.1" {
				t.Fatal("non-loopback published port")
			}
		}
	}
	if !strings.Contains(strings.Join(c.Config.Env, "\n"), "AGENTTEAMS_MANAGER_ENABLED=false") {
		t.Fatal("unexpected automatic Manager")
	}
	identity, err := os.ReadFile("../../docs/reports/team-delivery/p2/20261028-agentteams-t17/upstream-identity.json")
	if err != nil {
		t.Fatal("pinned upstream identity unavailable")
	}
	var pinned struct {
		ImageID string `json:"imageId"`
	}
	if json.Unmarshal(identity, &pinned) != nil || pinned.ImageID != c.Image {
		t.Fatal("upstream image changed")
	}
	token, err := exec.Command("docker", "exec", "pocketctl-team-external-t17-controller-1", "cat", "/var/run/agentteams/cli-token").Output()
	if err != nil {
		t.Fatal("local controller credential unavailable")
	}
	client, err := NewClient("http://127.0.0.1:19101", func(context.Context) (string, error) { return strings.TrimSpace(string(token)), nil }, nil)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestPinnedDockerControllerTaskProtocol(t *testing.T) {
	client := pinnedDockerClient(t)
	bound := TaskBinding{ProjectID: "pocketctl-t17-contract-probe", TaskID: "control-plane-node"}
	task, err := client.Task(context.Background(), bound)
	if err != nil {
		t.Fatal(err)
	}
	if task.ProjectID != bound.ProjectID || task.TaskID != bound.TaskID || task.Status != "pending" || task.SubmissionID != "" {
		t.Fatal("unexpected actual task state")
	}
	if data, err := client.Artifact(context.Background(), bound, "absent-submission", "shared/tasks/control-plane-node/result.md", 1024); err == nil || len(data) != 0 {
		t.Fatal("unsubmitted task exported")
	}
	bound.TaskID = "not-created"
	_, err = client.Task(context.Background(), bound)
	var remote *HTTPError
	if !errors.As(err, &remote) || remote.Status != 404 {
		t.Fatal("missing task did not retain upstream HTTP ambiguity")
	}
}

func TestRealWorkerSubmittedArtifactBytes(t *testing.T) {
	if os.Getenv("AGENTTEAMS_T17_TASK_ACCEPTANCE") != "1" {
		t.Skip("requires the original real Worker warmup submission")
	}
	client := pinnedDockerClient(t)
	const report = "../../docs/reports/team-delivery/p2/20261028-agentteams-t17/"
	data, err := os.ReadFile(report + "real-worker-progress.json")
	if err != nil {
		t.Fatal(err)
	}
	var original struct {
		Project          string `json:"project"`
		Task             string `json:"task"`
		State            string `json:"state"`
		ResultStatus     string `json:"resultStatus"`
		SubmissionID     string `json:"submissionId"`
		ProofHash        string `json:"expectedProofSHA256"`
		ObjectStoreProof struct {
			SHA256           string `json:"sha256"`
			Bytes            int    `json:"bytes"`
			MarkerBytesMatch bool   `json:"matchesFrozenMarkerBytes"`
			UTF8BOM          bool   `json:"utf8BOM"`
		} `json:"objectStoreProof"`
	}
	if json.Unmarshal(data, &original) != nil || !strings.HasPrefix(original.Project, "pctl-t17-warmup-") || original.Task != original.Project+"-01" || original.State != "submitted" || original.ResultStatus != "SUCCESS" || original.SubmissionID == "" {
		t.Fatal("unexpected original real Worker receipt")
	}
	bound := TaskBinding{ProjectID: original.Project, TaskID: original.Task, TeamID: "t17-pocketctl"}
	before, err := client.Task(context.Background(), bound)
	if err != nil || before.SubmissionID != original.SubmissionID {
		t.Fatalf("original submission changed: %v", err)
	}
	path := "shared/tasks/" + original.Task + "/proof.txt"
	proof, err := client.Artifact(context.Background(), bound, original.SubmissionID, path, 1024)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(proof)
	actual := hex.EncodeToString(digest[:])
	// The exporter must preserve actual source bytes. The warmup's strict
	// marker goal is separately recorded: this real tool wrote a UTF-8 BOM,
	// so its SUCCESS is not a human acceptance decision.
	if actual != original.ObjectStoreProof.SHA256 || len(proof) != original.ObjectStoreProof.Bytes {
		t.Fatal("downloaded artifact differs from independent object-store bytes")
	}
	after, err := client.Task(context.Background(), bound)
	if err != nil || after.SubmissionID != before.SubmissionID || after.Status != "submitted" {
		t.Fatal("download changed the original submission")
	}
	result := map[string]any{"at": time.Now().UTC().Format(time.RFC3339), "status": "PASS_REAL_WORKER_ARTIFACT_EXPORT_ONLY", "project": original.Project, "task": original.Task, "submission": original.SubmissionID, "path": path, "bytes": len(proof), "sha256": actual, "submissionUnchanged": true, "pocketctlCallLinked": false, "humanAcceptance": false, "matchesFrozenMarkerBytes": actual == original.ProofHash, "utf8BOM": original.ObjectStoreProof.UTF8BOM, "scope": "Exact source transport passed; strict warmup marker bytes not accepted"}
	encoded, _ := json.MarshalIndent(result, "", "  ")
	if os.WriteFile(report+"real-worker-artifact.json", append(encoded, '\n'), 0644) != nil {
		t.Fatal("could not save artifact evidence")
	}
}
