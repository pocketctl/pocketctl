package discovery

import (
	"fmt"
	"os/exec"
	"strings"
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

// detectVersion runs `<cli> --version` and extracts the leading version token.
// e.g. "2.1.175 (claude-code)" → "2.1.175". Returns "" if detection fails.
func detectVersion(cli string) string {
	out, err := exec.Command(cli, "--version").Output()
	if err != nil {
		return ""
	}
	s := strings.TrimSpace(string(out))
	if s == "" {
		return ""
	}
	if i := strings.IndexAny(s, " \t\n"); i > 0 {
		s = s[:i]
	}
	return s
}

func AgentTypeToCLI(agentType string) (string, error) {
	for _, a := range knownAgents {
		if a.Type == agentType {
			return a.CLIName, nil
		}
	}
	return "", fmt.Errorf("unknown agent type: %s", agentType)
}
