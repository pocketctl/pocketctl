package config

import (
	"os"
	"testing"
)

func TestCodexEditedFilesEnabled(t *testing.T) {
	tests := []struct {
		name  string
		value *string
		want  bool
	}{
		{name: "unset defaults enabled", want: true},
		{name: "one enables", value: stringPointer("1"), want: true},
		{name: "true enables case insensitively", value: stringPointer(" TRUE "), want: true},
		{name: "zero disables", value: stringPointer("0"), want: false},
		{name: "false disables case insensitively", value: stringPointer(" FALSE "), want: false},
		{name: "no disables", value: stringPointer("no"), want: false},
		{name: "off disables", value: stringPointer("off"), want: false},
		{name: "unknown value does not disable", value: stringPointer("typo"), want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			setOptionalEnv(t, "POCKETCTL_CODEX_EDITED_FILES", tt.value)
			if got := CodexEditedFilesEnabled(); got != tt.want {
				t.Fatalf("CodexEditedFilesEnabled() = %v, want %v", got, tt.want)
			}
		})
	}
}

func stringPointer(value string) *string {
	return &value
}

func setOptionalEnv(t *testing.T, key string, value *string) {
	t.Helper()
	previous, existed := os.LookupEnv(key)
	t.Cleanup(func() {
		if existed {
			_ = os.Setenv(key, previous)
			return
		}
		_ = os.Unsetenv(key)
	})
	if value == nil {
		if err := os.Unsetenv(key); err != nil {
			t.Fatal(err)
		}
		return
	}
	if err := os.Setenv(key, *value); err != nil {
		t.Fatal(err)
	}
}
