package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// authFile holds the persisted authentication data.
type authFile struct {
	RelayURL     string `json:"relay_url"`
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

// SaveAuth persists relay URL and tokens to disk.
func SaveAuth(relayURL, accessToken, refreshToken string) error {
	path, err := AuthPath()
	if err != nil {
		return err
	}
	data := authFile{
		RelayURL:     relayURL,
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
	}
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal auth: %w", err)
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		return fmt.Errorf("write auth: %w", err)
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
