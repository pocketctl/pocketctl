package config

import "os"

// HomeDir returns the user home directory used by pocketctl. We prefer an explicit
// HOME environment variable because CI and test harnesses on Windows often set HOME
// to isolate state, while os.UserHomeDir() prefers USERPROFILE.
func HomeDir() (string, error) {
	if home, ok := os.LookupEnv("HOME"); ok && home != "" {
		return home, nil
	}
	return os.UserHomeDir()
}
