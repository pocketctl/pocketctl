package agentcontrol

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenCodePromptYesEnablesOnce(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	manager := &fakeOpenCodeManager{detectedPath: "/opt/opencode"}
	var out bytes.Buffer
	result := MaybePromptOpenCode(context.Background(), strings.NewReader("yes\n"), &out, PromptContext{IsTTY: true}, manager)
	if result.Warning != nil || !result.Prompted || !result.Enabled || manager.enableCalls != 1 {
		t.Fatalf("result=%+v manager=%+v", result, manager)
	}
	cfg := DefaultConfig()
	cfg.OpenCode.State = StateEnabled
	if err := SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	result = MaybePromptOpenCode(context.Background(), strings.NewReader("yes\n"), &out, PromptContext{IsTTY: true}, manager)
	if result.Prompted || manager.enableCalls != 1 {
		t.Fatalf("prompt repeated: result=%+v calls=%d", result, manager.enableCalls)
	}
}

func TestOpenCodePromptNoPersistsDisabled(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	manager := &fakeOpenCodeManager{detectedPath: "/opt/opencode"}
	result := MaybePromptOpenCode(context.Background(), strings.NewReader("\n"), &bytes.Buffer{}, PromptContext{IsTTY: true}, manager)
	if !result.Prompted || result.Enabled || manager.enableCalls != 0 {
		t.Fatalf("result=%+v", result)
	}
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.OpenCode.State != StateDisabled || cfg.OpenCode.DecisionSource != SourceDaemonPrompt {
		t.Fatalf("config=%+v", cfg.OpenCode)
	}
}

func TestOpenCodePromptSkipsNonInteractiveContextsAfterDetection(t *testing.T) {
	contexts := []PromptContext{
		{IsTTY: false},
		{IsTTY: true, NoAgentPrompt: true},
		{IsTTY: true, IsDaemonChild: true},
		{IsTTY: true, IsRestart: true},
	}
	for i, promptContext := range contexts {
		t.Run(string(rune('a'+i)), func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			manager := &fakeOpenCodeManager{detectedPath: "/opt/opencode"}
			result := MaybePromptOpenCode(context.Background(), strings.NewReader("yes\n"), &bytes.Buffer{}, promptContext, manager)
			if result.Prompted || manager.detectCalls != 1 || manager.enableCalls != 0 {
				t.Fatalf("result=%+v manager=%+v", result, manager)
			}
		})
	}
}

func TestOpenCodePromptMissingBinaryAndEOFStayUndecided(t *testing.T) {
	tests := []struct {
		name    string
		manager *fakeOpenCodeManager
		input   string
	}{
		{"missing", &fakeOpenCodeManager{detectErr: ErrOpenCodeNotFound}, "yes\n"},
		{"eof", &fakeOpenCodeManager{detectedPath: "/opt/opencode"}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			result := MaybePromptOpenCode(context.Background(), strings.NewReader(tt.input), &bytes.Buffer{}, PromptContext{IsTTY: true}, tt.manager)
			if result.Prompted || result.Enabled {
				t.Fatalf("result=%+v", result)
			}
			cfg, err := LoadConfig()
			if err != nil || cfg.OpenCode.State != StateUndecided {
				t.Fatalf("config=%+v err=%v", cfg, err)
			}
		})
	}
}

func TestOpenCodePromptEnableFailureWarnsAndDoesNotEnable(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	manager := &fakeOpenCodeManager{detectedPath: filepath.Join(home, "opencode"), enableErr: errors.New("cannot install shim")}
	var out bytes.Buffer
	result := MaybePromptOpenCode(context.Background(), strings.NewReader("y\n"), &out, PromptContext{IsTTY: true}, manager)
	if result.Warning == nil || !strings.Contains(out.String(), "cannot install shim") {
		t.Fatalf("result=%+v output=%q", result, out.String())
	}
	cfg, err := LoadConfig()
	if err != nil || cfg.OpenCode.State != StateUndecided {
		t.Fatalf("config=%+v err=%v", cfg, err)
	}
}

func TestOpenCodePromptEnabledButBinaryMissingWarnsWithoutBlocking(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cfg := DefaultConfig()
	cfg.OpenCode.State = StateEnabled
	if err := SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}

	manager := &fakeOpenCodeManager{detectErr: ErrOpenCodeNotFound}
	var out bytes.Buffer
	result := MaybePromptOpenCode(context.Background(), strings.NewReader(""), &out, PromptContext{IsTTY: true}, manager)

	if result.Prompted || result.Enabled {
		t.Fatalf("missing binary must not prompt or enable: %+v", result)
	}
	if !errors.Is(result.Warning, ErrOpenCodeNotFound) {
		t.Fatalf("warning=%v, want ErrOpenCodeNotFound", result.Warning)
	}
	if !strings.Contains(out.String(), ErrOpenCodeNotFound.Error()) {
		t.Fatalf("missing binary warning not rendered: %q", out.String())
	}
}

type fakeOpenCodeManager struct {
	detectedPath string
	detectErr    error
	enableErr    error
	detectCalls  int
	enableCalls  int
}

func (f *fakeOpenCodeManager) Detect(context.Context) (string, string, error) {
	f.detectCalls++
	return f.detectedPath, "1.17.11", f.detectErr
}

func (f *fakeOpenCodeManager) EnableDetected(context.Context, string, EnableOptions) (Status, error) {
	f.enableCalls++
	return Status{State: StateEnabled}, f.enableErr
}

func (f *fakeOpenCodeManager) Disable(context.Context) error { return nil }

func (f *fakeOpenCodeManager) Status(context.Context) Status { return Status{} }
