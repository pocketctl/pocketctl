package agentteams

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Exercises pinned upstream filesync plus independent object readback. No
// Worker delegation or PocketCtl Call is created by this transport-only probe.
func TestAgentTeamsFrozenInputsActualStorageReadback(t *testing.T) {
	if os.Getenv("AGENTTEAMS_T17_INPUT_ACCEPTANCE") != "1" {
		t.Skip("explicit isolated Docker input acceptance required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	const container = "pocketctl-team-external-t17-controller-1"
	data, err := exec.CommandContext(ctx, "docker", "inspect", container).Output()
	if err != nil {
		t.Fatal("isolated controller unavailable")
	}
	var containers []struct {
		Image      string
		Config     struct{ Labels map[string]string }
		Mounts     []struct{ Type, Name string }
		HostConfig struct{ Privileged bool }
	}
	if json.Unmarshal(data, &containers) != nil || len(containers) != 1 || containers[0].Config.Labels["com.docker.compose.project"] != "pocketctl-team-external-t17" || containers[0].Image != "sha256:f3a5828f576bd9d9cf9a59af704af45f0e17e9b7c4d62e4564adac0b3d7dee97" || containers[0].HostConfig.Privileged {
		t.Fatal("unexpected deployment")
	}
	for _, mount := range containers[0].Mounts {
		if mount.Type != "volume" || !strings.HasPrefix(mount.Name, "pocketctl-team-external-t17_") {
			t.Fatal("unexpected mount")
		}
	}
	mcp, err := NewMCPProcess([]string{"docker", "exec", "-i", container, "python3"}, "/data/pocketctl-t17-bridge/mcp.json")
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("t17-frozen-file-transfer-01"))
	project := "pctl-" + hex.EncodeToString(digest[:16])
	blob := bytes.Repeat([]byte("t17-binary-frozen-input\x00\xff\n"), 85000)[:2*1024*1024]
	index := []byte(`{"schema_version":1,"probe":"T17 actual storage input transfer only"}`)
	makeFile := func(path string, data []byte) InputFile {
		hash := sha256.Sum256(data)
		return InputFile{path, hex.EncodeToString(hash[:]), data}
	}
	files := []InputFile{makeFile("inputs.json", index), makeFile("files/"+strings.Repeat("a", 64), blob)}
	result, err := mcp.Call(ctx, "pocketctl_inputs", map[string]any{"action": "upload_inputs", "projectId": project, "taskId": project + "-01", "files": files})
	if err != nil {
		t.Fatal(err)
	}
	var receipt struct {
		OK       bool `json:"ok"`
		Files    int  `json:"files"`
		Bytes    int  `json:"bytes"`
		Verified bool `json:"readbackVerified"`
	}
	if json.Unmarshal(result, &receipt) != nil || !receipt.OK || receipt.Files != 2 || receipt.Bytes != len(blob) || !receipt.Verified {
		t.Fatal("real readback not verified")
	}
	report := map[string]any{"at": time.Now().UTC().Format(time.RFC3339), "status": "PASS_STORAGE_TRANSFER_ONLY_NOT_D19", "project": project, "files": 2, "artifactBytes": len(blob), "sha256": files[1].SHA256, "readbackVerified": true, "newDelegations": 0, "pocketctlCall": false}
	reportData, _ := json.MarshalIndent(report, "", "  ")
	target := filepath.Join("..", "..", "docs", "reports", "team-delivery", "p2", "20261028-agentteams-t17", "frozen-input-storage.json")
	if err = os.WriteFile(target, append(reportData, '\n'), 0644); err != nil {
		t.Fatal(err)
	}
}
