package agentteams

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"io"
	"os/exec"
	"path/filepath"
	"time"
)

//go:embed mcp.py
var mcpBootstrap string

type MCPProcess struct {
	command    []string
	configPath string
}

// pythonCommand is fixed installation configuration, e.g. ["python3"]. It may
// include a container runner for isolated acceptance; it never comes from a task.
// The private config file is read inside that process and never passed in argv.
func NewMCPProcess(pythonCommand []string, configPath string) (*MCPProcess, error) {
	if len(pythonCommand) == 0 || pythonCommand[0] == "" || !filepath.IsAbs(configPath) {
		return nil, ErrConfiguration
	}
	return &MCPProcess{command: append([]string(nil), pythonCommand...), configPath: configPath}, nil
}
func (m *MCPProcess) Call(ctx context.Context, tool string, args map[string]any) (json.RawMessage, error) {
	action, _ := args["action"].(string)
	inputs := tool == "pocketctl_inputs" && action == "upload_inputs"
	allowed := inputs || tool == "projectflow" && (action == "create_project" || action == "plan_dag") || tool == "roomflow" && action == "create_task_room" || tool == "taskflow" && action == "delegate_task"
	if !allowed {
		return nil, ErrIdentity
	}
	data, err := json.Marshal(struct {
		Tool      string         `json:"tool"`
		Arguments map[string]any `json:"arguments"`
	}{tool, args})
	limit := MaxMetadataBytes
	if inputs {
		limit = MaxFrozenRequestBytes
	}
	if err != nil || len(data) > limit {
		return nil, ErrIdentity
	}
	timeout := 60 * time.Second
	if inputs {
		timeout = 110 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	argv := append(append([]string(nil), m.command[1:]...), "-c", mcpBootstrap, m.configPath)
	cmd := exec.CommandContext(ctx, m.command[0], argv...)
	cmd.Stdin = bytes.NewReader(data)
	var output bytes.Buffer
	cmd.Stdout = &boundedMCPWriter{writer: &output, remaining: MaxMetadataBytes}
	cmd.Stderr = io.Discard
	if err = cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, ErrTransport
	}
	if !json.Valid(output.Bytes()) {
		return nil, ErrResponse
	}
	return append(json.RawMessage(nil), output.Bytes()...), nil
}

func (m *MCPProcess) SupportsFrozenInputs() bool { return true }

type boundedMCPWriter struct {
	writer    io.Writer
	remaining int
}

func (w *boundedMCPWriter) Write(p []byte) (int, error) {
	if len(p) > w.remaining {
		return 0, ErrResponse
	}
	n, err := w.writer.Write(p)
	w.remaining -= n
	return n, err
}
