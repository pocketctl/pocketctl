package agentcontrol

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var (
	ErrCodexVersionUnsupported = errors.New("codex version does not support managed terminal control")
	ErrCodexCapabilities       = errors.New("codex managed capabilities are incomplete")
	ErrCodexProbeTimeout       = errors.New("codex capability probe timed out")
)

const defaultCodexProbeTimeout = 5 * time.Second

type CodexCapabilities struct {
	Version        string
	Core           bool
	TerminalRemote bool
	Steer          bool
	Approvals      bool
	UserInput      bool
	MCPElicitation bool
	SchemaHash     string
}

func (c CodexCapabilities) Managed() bool {
	return c.Core && c.TerminalRemote
}

type CodexProbe struct {
	Timeout        time.Duration
	Run            func(context.Context, string, ...string) ([]byte, error)
	GenerateSchema func(context.Context, string) ([]byte, error)
}

func (p CodexProbe) Probe(ctx context.Context, binary, version string) (CodexCapabilities, error) {
	caps := CodexCapabilities{Version: version}
	if !SupportsManagedCodexVersion(version) {
		return caps, fmt.Errorf("%w: have %s, need %s", ErrCodexVersionUnsupported, version, minimumManagedCodexVersion)
	}
	p = p.withDefaults()
	ctx, cancel := context.WithTimeout(ctx, p.Timeout)
	defer cancel()

	rootHelp, err := p.Run(ctx, binary, "--help")
	if err != nil {
		return caps, p.classifyError(ctx, err)
	}
	appHelp, err := p.Run(ctx, binary, "app-server", "--help")
	if err != nil {
		return caps, p.classifyError(ctx, err)
	}
	schema, err := p.GenerateSchema(ctx, binary)
	if err != nil {
		return caps, p.classifyError(ctx, err)
	}

	rootText, appText, schemaText := string(rootHelp), string(appHelp), string(schema)
	caps.TerminalRemote = strings.Contains(rootText, "--remote")
	appServer := strings.Contains(appText, "--listen") && strings.Contains(appText, "unix://")
	caps.Steer = containsAll(schemaText, "turn/steer")
	caps.Approvals = containsAll(schemaText,
		"item/commandExecution/requestApproval",
		"item/fileChange/requestApproval",
		"item/permissions/requestApproval",
	)
	caps.UserInput = containsAll(schemaText, "item/tool/requestUserInput")
	caps.MCPElicitation = containsAll(schemaText, "mcpServer/elicitation/request")
	caps.Core = appServer && containsAll(schemaText,
		"initialize", "thread/start", "thread/resume", "thread/turns/list",
		"turn/start", "turn/interrupt", "serverRequest/resolved",
	)
	hash := sha256.Sum256(schema)
	caps.SchemaHash = hex.EncodeToString(hash[:])
	if !caps.Managed() {
		return caps, fmt.Errorf("%w: core=%t terminal_remote=%t", ErrCodexCapabilities, caps.Core, caps.TerminalRemote)
	}
	return caps, nil
}

func (p CodexProbe) withDefaults() CodexProbe {
	if p.Timeout <= 0 {
		p.Timeout = defaultCodexProbeTimeout
	}
	if p.Run == nil {
		p.Run = func(ctx context.Context, binary string, args ...string) ([]byte, error) {
			return exec.CommandContext(ctx, binary, args...).CombinedOutput()
		}
	}
	if p.GenerateSchema == nil {
		p.GenerateSchema = generateCodexSchema
	}
	return p
}

func (p CodexProbe) classifyError(ctx context.Context, err error) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%w: %v", ErrCodexProbeTimeout, err)
	}
	return fmt.Errorf("%w: %v", ErrCodexCapabilities, err)
}

func containsAll(text string, values ...string) bool {
	for _, value := range values {
		if !strings.Contains(text, value) {
			return false
		}
	}
	return true
}

func generateCodexSchema(ctx context.Context, binary string) ([]byte, error) {
	dir, err := os.MkdirTemp("", "pocketctl-codex-schema-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	if out, err := exec.CommandContext(ctx, binary, "app-server", "generate-json-schema", "--experimental", "--out", dir).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("generate schema: %w: %s", err, oneLine(string(out)))
	}
	var schema []byte
	err = filepath.WalkDir(dir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		if len(schema)+len(raw) > 16<<20 {
			return errors.New("generated Codex schema exceeds 16 MiB")
		}
		schema = append(schema, raw...)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(schema) == 0 {
		return nil, errors.New("generated Codex schema is empty")
	}
	return schema, nil
}
