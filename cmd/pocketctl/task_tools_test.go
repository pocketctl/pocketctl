package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/i18n"
)

func TestTaskToolsCommands(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var out bytes.Buffer
	for _, args := range [][]string{nil, {"status"}, {"--help"}, {"enable", "codex"}, {"disable", "claude"}, {"status", "claude-code"}, {"reset", "codex"}} {
		out.Reset()
		if err := runTaskTools(args, &out); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		if out.Len() == 0 {
			t.Fatal("empty output")
		}
	}
	if value, _ := config.LoadTaskTools("codex"); value != nil {
		t.Fatal("reset failed")
	}
	if value, _ := config.LoadTaskTools("claude-code"); value == nil || *value {
		t.Fatal("disable failed")
	}
	for _, args := range [][]string{{"enable"}, {"disable", "all"}, {"enable", "opencode"}, {"status", "codex", "extra"}, {"typo"}} {
		if err := runTaskTools(args, &out); err == nil {
			t.Fatalf("accepted invalid args: %v", args)
		}
	}
}

func TestTaskToolsHelpBothLanguages(t *testing.T) {
	old := i18n.Current()
	defer i18n.Set(old)
	for _, lang := range []i18n.Lang{i18n.English, i18n.Chinese} {
		i18n.Set(lang)
		for _, key := range []string{"help.body", "task_tools.help"} {
			help := i18n.T(key)
			for _, text := range []string{"task-tools", "codex", "claude-code", "inherit", "reset", "app-server"} {
				if !strings.Contains(help, text) {
					t.Fatalf("%s missing %s", key, text)
				}
			}
		}
	}
}
