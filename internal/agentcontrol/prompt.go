package agentcontrol

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/i18n"
)

type PromptContext struct {
	IsTTY         bool
	NoAgentPrompt bool
	IsDaemonChild bool
	IsRestart     bool
}

type PromptResult struct {
	Detected bool
	Prompted bool
	Enabled  bool
	Warning  error
}

func MaybePromptOpenCode(ctx context.Context, input io.Reader, output io.Writer, promptContext PromptContext, manager Manager) PromptResult {
	result := PromptResult{}
	cfg, err := LoadConfig()
	if err != nil {
		result.Warning = err
		fmt.Fprintln(output, i18n.T("agent.prompt_warning", err))
		return result
	}
	path, _, detectErr := manager.Detect(ctx)
	if detectErr != nil {
		if cfg.OpenCode.State == StateEnabled {
			result.Warning = detectErr
			fmt.Fprintln(output, i18n.T("agent.prompt_warning", detectErr))
		}
		return result
	}
	result.Detected = true
	if cfg.OpenCode.State != StateUndecided || promptContext.NoAgentPrompt || !promptContext.IsTTY || promptContext.IsDaemonChild || promptContext.IsRestart {
		return result
	}
	fmt.Fprint(output, i18n.T("agent.opencode_prompt"))
	answer, answered := readYesNo(input)
	if !answered {
		return result
	}
	result.Prompted = true
	if !answer {
		cfg.OpenCode.State = StateDisabled
		cfg.OpenCode.DecisionSource = SourceDaemonPrompt
		cfg.OpenCode.DecidedAt = time.Now().UTC()
		if err := SaveConfig(cfg); err != nil {
			result.Warning = err
			fmt.Fprintln(output, i18n.T("agent.prompt_warning", err))
		}
		return result
	}
	_, err = manager.EnableDetected(ctx, path, EnableOptions{DecisionSource: SourceDaemonPrompt})
	if err != nil {
		result.Warning = err
		fmt.Fprintln(output, i18n.T("agent.prompt_warning", err))
		return result
	}
	result.Enabled = true
	return result
}

func readYesNo(input io.Reader) (bool, bool) {
	line, err := bufio.NewReader(input).ReadString('\n')
	if err == io.EOF && len(line) == 0 {
		return false, false
	}
	if err != nil && err != io.EOF {
		return false, false
	}
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes", "是":
		return true, true
	case "", "n", "no", "否":
		return false, true
	default:
		return false, true
	}
}
