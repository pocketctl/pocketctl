package discovery

import (
	"fmt"
	"os/exec"
	"regexp"
)

type AgentInfo struct {
	Type    string `json:"type"`
	CLIName string `json:"cli_name"`
	Path    string `json:"path"`
	Version string `json:"version,omitempty"`
}

var knownAgents = []struct {
	Type    string
	CLIName string
}{
	{"claude-code", "claude"},
	{"opencode", "opencode"},
	{"codex", "codex"},
}

var versionRe = regexp.MustCompile(`\d+\.\d+(?:\.\d+)?`)

func DiscoverAgents() []AgentInfo {
	var agents []AgentInfo
	for _, a := range knownAgents {
		path, err := exec.LookPath(a.CLIName)
		if err != nil {
			continue
		}
		agents = append(agents, AgentInfo{Type: a.Type, CLIName: a.CLIName, Path: path, Version: detectVersion(a.CLIName)})
	}
	return agents
}

// detectVersion runs `<cli> --version` and extracts the first version-number token.
// e.g. "2.1.175 (Claude Code)" → "2.1.175", "codex-cli 0.124.0" → "0.124.0", "1.2.15" → "1.2.15".
func detectVersion(cli string) string {
	out, err := exec.Command(cli, "--version").Output()
	if err != nil || len(out) == 0 {
		return ""
	}
	return versionRe.FindString(string(out))
}

func AgentTypeToCLI(agentType string) (string, error) {
	for _, a := range knownAgents {
		if a.Type == agentType {
			return a.CLIName, nil
		}
	}
	return "", fmt.Errorf("unknown agent type: %s", agentType)
}
