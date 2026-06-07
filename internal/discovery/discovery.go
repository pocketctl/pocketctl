package discovery

import (
	"fmt"
	"os/exec"
)

type AgentInfo struct {
	Type    string `json:"type"`
	CLIName string `json:"cli_name"`
	Path    string `json:"path"`
}

var knownAgents = []struct {
	Type    string
	CLIName string
}{
	{"claude-code", "claude"},
	{"opencode", "opencode"},
	{"codex", "codex"},
}

func DiscoverAgents() []AgentInfo {
	var agents []AgentInfo
	for _, a := range knownAgents {
		path, err := exec.LookPath(a.CLIName)
		if err != nil { continue }
		agents = append(agents, AgentInfo{Type: a.Type, CLIName: a.CLIName, Path: path})
	}
	return agents
}

func AgentTypeToCLI(agentType string) (string, error) {
	for _, a := range knownAgents {
		if a.Type == agentType { return a.CLIName, nil }
	}
	return "", fmt.Errorf("unknown agent type: %s", agentType)
}
