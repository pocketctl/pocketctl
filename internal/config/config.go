package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// authFile holds the persisted authentication data.
type authFile struct {
	RelayURL     string `json:"relay_url"`
	ProdRelayURL string `json:"prod_relay_url,omitempty"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

// ConfigDir returns the pocketctl config directory (~/.pocketctl/).
// Creates it if it doesn't exist.
func ConfigDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("get home dir: %w", err)
	}
	dir := filepath.Join(home, ".pocketctl")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", fmt.Errorf("create config dir: %w", err)
	}
	return dir, nil
}

// AuthPath returns the path to the auth config file.
func AuthPath() (string, error) {
	dir, err := ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "auth.json"), nil
}

// ApprovalSocketPath returns the user-level fixed path to the approval Unix
// domain socket (~/.pocketctl/approval.sock). This path is shared between the
// daemon (which listens on it) and the PreToolUse hook (which connects to it),
// so it MUST be a single, stable, user-global value — it is the contract that
// lets a `claude` process the user launched in their own terminal reach the
// running daemon. Returns "" only if the home dir cannot be resolved.
func ApprovalSocketPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return approvalSocketPathFor(runtime.GOOS, home)
}

// ControlSocketPath 返回 daemon 本地控制 socket 路径（~/.pocketctl/control.sock）。
// keep-awake on/off/status 等本地命令通过它与运行中的 daemon 通信（不经 relay）。
// 与 ApprovalSocketPath 同置 ~/.pocketctl/ 下，权限由 IPCListener 设 0600。
// 返回 "" 仅当 home 目录无法解析。
func ControlSocketPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return controlSocketPathFor(runtime.GOOS, home)
}

// AgentControlSocketPath returns the dedicated local endpoint used by terminal
// agent launchers. It intentionally does not reuse ControlSocketPath because
// the keep-awake control server already owns that listener.
func AgentControlSocketPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return agentControlSocketPathFor(runtime.GOOS, home)
}

// controlSocketPathFor 是 ControlSocketPath 的纯函数核心（可注入 GOOS，便于单测）。
// Windows 必须用 \\.\pipe\ 前缀的 named pipe 名（winio.CreateNamedPipe 要求），
// 否则 listen/dial 失败（这是 keep-awake 与 approval 在 Windows 报
// "Incorrect function" 的根因）。Unix 保持 ~/.pocketctl/control.sock 文件路径。
func controlSocketPathFor(goos, home string) string {
	if goos == "windows" {
		return `\\.\pipe\pocketctl-control`
	}
	return filepath.Join(home, ".pocketctl", "control.sock")
}

func agentControlSocketPathFor(goos, home string) string {
	if goos == "windows" {
		return `\\.\pipe\pocketctl-agent-control`
	}
	return filepath.Join(home, ".pocketctl", "agent-control.sock")
}

// approvalSocketPathFor 是 ApprovalSocketPath 的纯函数核心（同上理由加平台分支）。
func approvalSocketPathFor(goos, home string) string {
	if goos == "windows" {
		return `\\.\pipe\pocketctl-approval`
	}
	return filepath.Join(home, ".pocketctl", "approval.sock")
}

// SaveAuth persists relay URL and tokens to disk, preserving prod_relay_url if present.
func SaveAuth(relayURL, accessToken, refreshToken string) error {
	path, err := AuthPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create auth dir: %w", err)
	}
	// Read existing data to preserve prod_relay_url
	data := authFile{}
	if raw, err := os.ReadFile(path); err == nil {
		json.Unmarshal(raw, &data)
	}
	data.RelayURL = relayURL
	data.AccessToken = accessToken
	data.RefreshToken = refreshToken
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal auth: %w", err)
	}
	// Atomic write: stage to a temp file in the same dir, then rename. A crash
	// or IO error mid-write leaves the previous auth.json intact (rename is
	// atomic on the same filesystem), so the daemon never ends up with a
	// truncated/missing refresh token — the gap that let a stale refresh token
	// be reused after rotation (the m3-pro breach incident).
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return fmt.Errorf("write auth (tmp): %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename auth: %w", err)
	}
	return nil
}

// LoadAuth reads the persisted auth data from disk.
func LoadAuth() (relayURL, accessToken, refreshToken string, err error) {
	path, err := AuthPath()
	if err != nil {
		return "", "", "", err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", "", "", fmt.Errorf("read auth: %w", err)
	}
	var data authFile
	if err := json.Unmarshal(raw, &data); err != nil {
		return "", "", "", fmt.Errorf("parse auth: %w", err)
	}
	return data.RelayURL, data.AccessToken, data.RefreshToken, nil
}

// LoadToken returns the stored access token, or empty string if not found.
func LoadToken() (string, error) {
	_, accessToken, _, err := LoadAuth()
	if err != nil {
		return "", err
	}
	return accessToken, nil
}

// LoadProdRelayURL reads the prod_relay_url from the auth config file.
// Returns empty string if not set, error only on file read/parse failure.
func LoadProdRelayURL() (string, error) {
	path, err := AuthPath()
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read auth: %w", err)
	}
	var data authFile
	if err := json.Unmarshal(raw, &data); err != nil {
		return "", fmt.Errorf("parse auth: %w", err)
	}
	return data.ProdRelayURL, nil
}

// SaveProdRelayURL writes the prod_relay_url to the auth config file,
// preserving all other fields.
func SaveProdRelayURL(relayURL string) error {
	path, err := AuthPath()
	if err != nil {
		return err
	}
	// Read existing data to preserve all fields
	data := authFile{}
	if raw, err := os.ReadFile(path); err == nil {
		json.Unmarshal(raw, &data)
	}
	data.ProdRelayURL = relayURL
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal auth: %w", err)
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		return fmt.Errorf("write auth: %w", err)
	}
	return nil
}
