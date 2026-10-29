package session

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestAgentTeamsDeployedBridgeRecoversOriginal(t *testing.T) {
	if os.Getenv("AGENTTEAMS_T17_DEPLOYED_BRIDGE_ACCEPTANCE") != "1" {
		t.Skip("explicit isolated deployed bridge acceptance required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const report = "../../docs/reports/team-delivery/p2/20261028-agentteams-t17/"
	deployed, err := os.ReadFile(report + "bridge-deployment.json")
	if err != nil {
		t.Fatal(err)
	}
	var deployment struct {
		ImageID string `json:"imageId"`
	}
	if json.Unmarshal(deployed, &deployment) != nil || deployment.ImageID == "" {
		t.Fatal("deployment identity missing")
	}
	inspect, err := exec.CommandContext(ctx, "docker", "inspect", "pocketctl-team-external-t17-bridge-1").Output()
	if err != nil {
		t.Fatal("bridge not deployed")
	}
	var c []struct {
		Image           string
		State           struct{ Running bool }
		Config          struct{ Labels map[string]string }
		Mounts          []struct{ Type, Name string }
		HostConfig      struct{ Privileged bool }
		NetworkSettings struct {
			Ports    map[string][]struct{ HostIp, HostPort string }
			Networks map[string]json.RawMessage
		}
	}
	if json.Unmarshal(inspect, &c) != nil || len(c) != 1 || c[0].Image != deployment.ImageID || !c[0].State.Running || c[0].HostConfig.Privileged || c[0].Config.Labels["com.docker.compose.project"] != "pocketctl-team-external-t17" {
		t.Fatal("bridge identity mismatch")
	}
	for _, m := range c[0].Mounts {
		if m.Type != "volume" || !strings.HasPrefix(m.Name, "pocketctl-team-external-t17_bridge-") {
			t.Fatal("unexpected bridge mount")
		}
	}
	if len(c[0].NetworkSettings.Networks) != 2 || c[0].NetworkSettings.Networks["pocketctl-team-external-t17_default"] == nil || c[0].NetworkSettings.Networks["pocketctl-team-external-t17_edge"] == nil {
		t.Fatal("unexpected network")
	}
	for _, ps := range c[0].NetworkSettings.Ports {
		for _, p := range ps {
			if p.HostIp != "127.0.0.1" || p.HostPort != "19104" {
				t.Fatal("unexpected bridge port")
			}
		}
	}
	const private = "/tmp/pocketctl-team-external-t17"
	token, err := os.ReadFile(private + "/bridge-seed/bridge.token")
	if err != nil {
		t.Fatal("bridge private credential unavailable")
	}
	client, err := NewAgentTeamsBridgeClient("http://127.0.0.1:19104", "agentteams-v1.2.5-t17-20261028", func(context.Context) (string, error) { return string(token), nil }, nil)
	if err != nil {
		t.Fatal(err)
	}
	caps, err := client.Capabilities(ctx)
	if err != nil || caps.AutomaticRetry || caps.HardCostLimit || caps.CostReporting || !caps.IdempotentSubmit || !caps.ArtifactExport {
		t.Fatal("unproven capabilities", caps, err)
	}
	j, err := OpenAgentTeamsJournal(private+"/go-bridge-journal", "t17-bridge-probe-installation-20261028", "agentteams-v1.2.5-t17-20261028")
	if err != nil {
		t.Fatal(err)
	}
	r, original, err := j.Load(ctx, "t17-durable-bridge-probe-01")
	j.Close()
	if err != nil || original == nil || original.State != ExternalSucceeded {
		t.Fatal("original receipt absent", err)
	}
	resumed, err := client.Submit(ctx, r)
	if err != nil || resumed.RemoteTaskID != original.RemoteTaskID || resumed.RemoteSubmissionID != original.RemoteSubmissionID || resumed.Sequence != original.Sequence {
		t.Fatal("deployed original changed", resumed, err)
	}
	parts := strings.Split(original.RemoteTaskID, "/")
	if len(parts) != 2 {
		t.Fatal("remote task identity invalid")
	}
	path := "shared/tasks/" + parts[1] + "/proof.md"
	artifact, err := client.ExportArtifact(ctx, r.Identity, path, 4096)
	if err != nil || string(artifact.Data) != "T17-DURABLE-BRIDGE-ORIGINAL\n" || artifact.SubmissionID != original.RemoteSubmissionID {
		t.Fatal("deployed snapshot export failed", err)
	}
	check := `import sqlite3,json;from pathlib import Path;p=list(Path('/var/lib/pocketctl-bridge/journal').glob('*/external-executions.db'));assert len(p)==1;c=sqlite3.connect('file:'+str(p[0])+'?mode=ro',uri=True);print(json.dumps({'operations':c.execute('SELECT COUNT(*) FROM agentteams_operations').fetchone()[0],'requests':c.execute('SELECT COUNT(*) FROM external_executions').fetchone()[0],'artifacts':c.execute('SELECT COUNT(*) FROM agentteams_artifacts').fetchone()[0]}))`
	counts, err := exec.CommandContext(ctx, "docker", "exec", "pocketctl-team-external-t17-bridge-1", "python3", "-c", check).Output()
	if err != nil {
		t.Fatal("deployed journal audit unavailable")
	}
	var audit struct{ Operations, Requests, Artifacts int }
	if json.Unmarshal(counts, &audit) != nil || audit.Operations != 4 || audit.Requests != 1 || audit.Artifacts != 1 {
		t.Fatal("deployed journal changed", string(counts))
	}
	result := map[string]any{"at": time.Now().UTC().Format(time.RFC3339), "status": "PASS_DEPLOYED_BRIDGE_ORIGINAL_RECOVERY_ONLY", "bridgeImageId": deployment.ImageID, "originalIdentity": r.Identity, "remoteTask": resumed.RemoteTaskID, "submission": resumed.RemoteSubmissionID, "sequence": resumed.Sequence, "artifact": map[string]any{"path": path, "bytes": len(artifact.Data), "sha256": artifact.SHA256}, "journal": audit, "pocketctlCallLinked": false, "humanAcceptance": false, "scope": "Actual Docker HTTP bridge recovered the cold-migrated original request and immutable artifact. No new model task or D19 acceptance."}
	encoded, _ := json.MarshalIndent(result, "", "  ")
	if err = os.WriteFile(report+"deployed-bridge-recovery.json", append(encoded, '\n'), 0644); err != nil {
		t.Fatal(err)
	}
}
