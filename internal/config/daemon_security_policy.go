package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	daemonSecurityPolicyVersion = 1
	maxDaemonSecurityPolicySize = 64 * 1024
	maxAllowedCwdRoots          = 64
)

// DaemonSecurityPolicy is the local operator-controlled policy that must
// survive a verified self-update restart. It contains no credentials.
type DaemonSecurityPolicy struct {
	AllowedCwdRoots                 []string
	AllowDangerousRemotePermissions bool
	TrustedActionPolicy             string
}

type daemonSecurityPolicyFile struct {
	Version                         int      `json:"version"`
	AllowedCwdRoots                 []string `json:"allowed_cwd_roots"`
	AllowDangerousRemotePermissions bool     `json:"allow_dangerous_remote_permissions"`
	TrustedActionPolicy             string   `json:"trusted_action_policy"`
}

// DaemonSecurityPolicyPath returns the private per-user policy file path.
func DaemonSecurityPolicyPath() (string, error) {
	dir, err := ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "daemon-security-policy.json"), nil
}

func validateDaemonSecurityPolicy(policy DaemonSecurityPolicy) error {
	if len(policy.AllowedCwdRoots) > maxAllowedCwdRoots {
		return fmt.Errorf("daemon security policy has too many allowed cwd roots")
	}
	for _, root := range policy.AllowedCwdRoots {
		if root == "" || !filepath.IsAbs(root) {
			return fmt.Errorf("daemon security policy cwd root must be absolute: %q", root)
		}
		if strings.ContainsAny(root, "\x00\r\n") {
			return fmt.Errorf("daemon security policy cwd root contains a control character")
		}
	}
	switch policy.TrustedActionPolicy {
	case "off", "observe", "on":
	default:
		return fmt.Errorf("daemon security policy trusted action policy must be off, observe, or on")
	}
	return nil
}

// SaveDaemonSecurityPolicy atomically persists the effective, already
// canonicalized daemon policy. A failed write leaves the previous policy
// intact, and the file is private even though it contains no credentials.
func SaveDaemonSecurityPolicy(policy DaemonSecurityPolicy) error {
	if err := validateDaemonSecurityPolicy(policy); err != nil {
		return err
	}
	path, err := DaemonSecurityPolicyPath()
	if err != nil {
		return err
	}
	disk := daemonSecurityPolicyFile{
		Version:                         daemonSecurityPolicyVersion,
		AllowedCwdRoots:                 append([]string(nil), policy.AllowedCwdRoots...),
		AllowDangerousRemotePermissions: policy.AllowDangerousRemotePermissions,
		TrustedActionPolicy:             policy.TrustedActionPolicy,
	}
	raw, err := json.MarshalIndent(disk, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal daemon security policy: %w", err)
	}
	raw = append(raw, '\n')

	tmp, err := os.CreateTemp(filepath.Dir(path), ".daemon-security-policy-*.tmp")
	if err != nil {
		return fmt.Errorf("create daemon security policy temp file: %w", err)
	}
	tmpPath := tmp.Name()
	keepTemp := true
	defer func() {
		_ = tmp.Close()
		if keepTemp {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return fmt.Errorf("chmod daemon security policy temp file: %w", err)
	}
	if _, err := tmp.Write(raw); err != nil {
		return fmt.Errorf("write daemon security policy: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync daemon security policy: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close daemon security policy: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("replace daemon security policy: %w", err)
	}
	keepTemp = false
	if err := syncDaemonSecurityPolicyDirectory(filepath.Dir(path)); err != nil {
		return fmt.Errorf("sync daemon security policy directory: %w", err)
	}
	return nil
}

// LoadDaemonSecurityPolicy rejects malformed, oversized, unknown-version, or
// extended input. Callers must additionally revalidate that each root still
// exists before stopping a live daemon.
func LoadDaemonSecurityPolicy() (DaemonSecurityPolicy, error) {
	path, err := DaemonSecurityPolicyPath()
	if err != nil {
		return DaemonSecurityPolicy{}, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return DaemonSecurityPolicy{}, fmt.Errorf("read daemon security policy: %w", err)
	}
	if len(raw) > maxDaemonSecurityPolicySize {
		return DaemonSecurityPolicy{}, fmt.Errorf("daemon security policy exceeds %d bytes", maxDaemonSecurityPolicySize)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var disk daemonSecurityPolicyFile
	if err := decoder.Decode(&disk); err != nil {
		return DaemonSecurityPolicy{}, fmt.Errorf("parse daemon security policy: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return DaemonSecurityPolicy{}, fmt.Errorf("parse daemon security policy: trailing data")
	}
	if disk.Version != daemonSecurityPolicyVersion {
		return DaemonSecurityPolicy{}, fmt.Errorf("unsupported daemon security policy version: %d", disk.Version)
	}
	policy := DaemonSecurityPolicy{
		AllowedCwdRoots:                 append([]string(nil), disk.AllowedCwdRoots...),
		AllowDangerousRemotePermissions: disk.AllowDangerousRemotePermissions,
		TrustedActionPolicy:             disk.TrustedActionPolicy,
	}
	if err := validateDaemonSecurityPolicy(policy); err != nil {
		return DaemonSecurityPolicy{}, err
	}
	return policy, nil
}
