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

var knownAgents = []struct {
	Type    string
	CLIName string
	Package string
}{
	{"claude-code", "claude", "@anthropic-ai/claude-code"},
	{"opencode", "opencode", "opencode-ai"},
	{"codex", "codex", "@openai/codex"},
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

// detectVersion runs `<cli> --version` and extracts the first version-number token.
// e.g. "2.1.175 (Claude Code)" → "2.1.175", "codex-cli 0.124.0" → "0.124.0", "1.2.15" → "1.2.15".
func detectVersion(cli string) string {
	out, err := exec.Command(cli, "--version").Output()
	if err != nil || len(out) == 0 {
		return ""
	}
	return versionRe.FindString(string(out))
}

// detectLatest queries the npm registry for the latest published version (5s timeout).
// Works for npm-distributed agents even when installed via the official script,
// because the registry version mirrors the official release.
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
