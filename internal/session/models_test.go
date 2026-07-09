package session

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestListCodexModelsReadsCodexCache(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	codexDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexDir, "config.toml"), []byte(`model = "gpt-5.4"`), 0o644); err != nil {
		t.Fatal(err)
	}
	cache := `{"models":[
		{"slug":"hidden-model","visibility":"hidden"},
		{"slug":"gpt-5.5","visibility":"list"},
		{"slug":"gpt-5.4","visibility":"list"},
		{"slug":"gpt-5.4-mini","visibility":"list"}
	]}`
	if err := os.WriteFile(filepath.Join(codexDir, "models_cache.json"), []byte(cache), 0o644); err != nil {
		t.Fatal(err)
	}

	got := listCodexModels()
	var aliases []string
	for _, model := range got {
		aliases = append(aliases, model.Alias)
		if model.Alias != model.Name {
			t.Fatalf("codex model should use slug for alias and name, got %#v", model)
		}
	}
	want := []string{"gpt-5.4", "gpt-5.5", "gpt-5.4-mini"}
	if !reflect.DeepEqual(gotAliases(got), want) {
		t.Fatalf("aliases = %v, want %v", aliases, want)
	}
}

func TestListCodexModelsFallback(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	got := listCodexModels()
	want := []string{"gpt-5.5", "gpt-5.4", "gpt-5.4-mini"}
	if !reflect.DeepEqual(gotAliases(got), want) {
		t.Fatalf("aliases = %v, want %v", gotAliases(got), want)
	}
}

func gotAliases(models []protocol.ModelOption) []string {
	aliases := make([]string, 0, len(models))
	for _, model := range models {
		aliases = append(aliases, model.Alias)
	}
	return aliases
}
