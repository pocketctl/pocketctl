package watcher

import (
	"os"
	"path/filepath"
	"testing"
)

// SDK-spawned sessions carry an entrypoint with the "sdk" prefix in their
// per-PID metadata; interactive sessions report "cli" or omit the field.
// The field must round-trip through parseSessionFile without extra IO.
func TestParseSessionFileEntrypoint(t *testing.T) {
	dir := t.TempDir()
	for _, tc := range []struct {
		name string
		json string
		want string
	}{
		{"interactive cli session", `{"pid":1,"sessionId":"s1","cwd":"/repo","status":"busy","entrypoint":"cli"}`, "cli"},
		{"sdk python session", `{"pid":2,"sessionId":"s2","cwd":"/repo","status":"busy","entrypoint":"sdk-py"}`, "sdk-py"},
		{"missing entrypoint field", `{"pid":3,"sessionId":"s3","cwd":"/repo","status":"idle"}`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, tc.name+".json")
			if err := os.WriteFile(path, []byte(tc.json), 0o600); err != nil {
				t.Fatal(err)
			}
			session, err := parseSessionFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if session.Entrypoint != tc.want {
				t.Fatalf("Entrypoint = %q, want %q", session.Entrypoint, tc.want)
			}
		})
	}
}
