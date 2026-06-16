package discovery

import (
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"time"
)

type AgentInfo struct {
	Type    string `json:"type"`
	CLIName string `json:"cli_name"`
	Path    string `json:"path"`
	Version string `json:"version,omitempty"`
	Latest  string `json:"latest,omitempty"`
}

// knownAgents: each agent's CLI name, npm package (for version check), and upgrade command.
// UpdateCmd is the agent's built-in upgrade command; empty means fall back to `npm install -g <package>@latest`.
var knownAgents = []struct {
	Type      string
	CLIName   string
	Package   string
	UpdateCmd string
}{
	{"claude-code", "claude", "@anthropic-ai/claude-code", "claude update"},
	{"opencode", "opencode", "opencode-ai", "opencode upgrade"},
	{"codex", "codex", "@openai/codex", ""}, // no built-in update; npm install -g @openai/codex@latest
}

var versionRe = regexp.MustCompile(`\d+\.\d+(?:\.\d+)?`)

func DiscoverAgents() []AgentInfo {
	var agents []AgentInfo
	for _, a := range knownAgents {
		path, err := exec.LookPath(a.CLIName)
		if err != nil {
			continue
		}
		agents = append(agents, AgentInfo{
			Type:    a.Type,
			CLIName: a.CLIName,
			Path:    path,
			Version: detectVersion(a.CLIName),
			Latest:  detectLatest(a.Package),
		})
	}
	return agents
}

// AgentUpgradeInfo returns the upgrade command and npm package for an agent type.
// updateCmd non-empty → run it directly; empty → run `npm install -g <package>@latest`.
func AgentUpgradeInfo(agentType string) (updateCmd, pkg string, err error) {
	for _, a := range knownAgents {
		if a.Type == agentType {
			return a.UpdateCmd, a.Package, nil
		}
	}
	return "", "", fmt.Errorf("unknown agent type: %s", agentType)
}

func detectVersion(cli string) string {
	out, err := exec.Command(cli, "--version").Output()
	if err != nil || len(out) == 0 {
		return ""
	}
	return versionRe.FindString(string(out))
}

// detectLatest queries the npm registry for the latest published version (5s timeout).
func detectLatest(pkg string) string {
	if pkg == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "npm", "view", pkg, "version").Output()
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
