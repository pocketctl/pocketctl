package agentcontrol

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	appconfig "github.com/pocketctl/pocketctl/internal/config"
)

type claudeMCPConfig struct {
	MCPServers map[string]claudeMCPServer `json:"mcpServers"`
}

type claudeMCPServer struct {
	Type    string   `json:"type"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

func ensureClaudeChannelMCPConfig(pocketctlPath string) (string, error) {
	path, err := appconfig.ClaudeChannelMCPConfigPath()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", fmt.Errorf("create Claude Channel config directory: %w", err)
	}
	body, err := json.MarshalIndent(claudeMCPConfig{MCPServers: map[string]claudeMCPServer{
		"pocketctl": {Type: "stdio", Command: pocketctlPath, Args: []string{"__claude_channel"}},
	}}, "", "  ")
	if err != nil {
		return "", err
	}
	body = append(body, '\n')
	tmp, err := os.CreateTemp(filepath.Dir(path), ".mcp-*")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if _, err := tmp.Write(body); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return "", err
	}
	return path, nil
}
