package agentcontrol

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

var (
	ErrClaudeManagedCapabilities = errors.New("claude managed runtime capabilities are incomplete")
	ErrClaudeProbeTimeout        = errors.New("claude managed capability probe timed out")
)

const defaultClaudeProbeTimeout = 5 * time.Second

// ClaudeManagedCapabilities deliberately separates useful CLI surface from
// the six authority guarantees required for shared terminal control. A
// --remote-control flag alone must never be treated as a local attach API.
type ClaudeManagedCapabilities struct {
	Version                 string
	RemoteControlAdvertised bool
	StreamJSONInput         bool
	Resume                  bool

	SharedAuthority         bool `json:"shared_authority"`
	IndependentSubscription bool `json:"independent_subscription"`
	SendSteerInterrupt      bool `json:"send_steer_interrupt"`
	PendingApprovals        bool `json:"pending_approvals"`
	FirstWriterResolved     bool `json:"first_writer_resolved"`
	ReattachAfterRestart    bool `json:"reattach_after_restart"`
}

func (c ClaudeManagedCapabilities) Managed() bool {
	return c.SharedAuthority &&
		c.IndependentSubscription &&
		c.SendSteerInterrupt &&
		c.PendingApprovals &&
		c.FirstWriterResolved &&
		c.ReattachAfterRestart
}

type ClaudeProbe struct {
	Timeout time.Duration
	Run     func(context.Context, string, ...string) ([]byte, error)
	// Manifest is intentionally nil by default. It may only be wired when a
	// Claude release exposes a documented, machine-readable local runtime
	// capability contract; help-text guesses cannot populate authority fields.
	Manifest func(context.Context, string) ([]byte, error)
}

func (p ClaudeProbe) Probe(ctx context.Context, binary, version string) (ClaudeManagedCapabilities, error) {
	caps := ClaudeManagedCapabilities{Version: version}
	if p.Timeout <= 0 {
		p.Timeout = defaultClaudeProbeTimeout
	}
	if p.Run == nil {
		p.Run = func(ctx context.Context, binary string, args ...string) ([]byte, error) {
			return exec.CommandContext(ctx, binary, args...).CombinedOutput()
		}
	}
	ctx, cancel := context.WithTimeout(ctx, p.Timeout)
	defer cancel()
	help, err := p.Run(ctx, binary, "--help")
	if err != nil {
		return caps, p.classifyError(ctx, err)
	}
	helpText := string(help)
	caps.RemoteControlAdvertised = strings.Contains(helpText, "--remote-control")
	caps.StreamJSONInput = strings.Contains(helpText, "--input-format") &&
		strings.Contains(helpText, "stream-json")
	caps.Resume = strings.Contains(helpText, "--resume")

	if p.Manifest == nil {
		return caps, fmt.Errorf("%w: no documented machine-readable local runtime manifest", ErrClaudeManagedCapabilities)
	}
	manifest, err := p.Manifest(ctx, binary)
	if err != nil {
		return caps, p.classifyError(ctx, err)
	}
	if err := json.Unmarshal(manifest, &caps); err != nil {
		return caps, fmt.Errorf("%w: invalid manifest: %v", ErrClaudeManagedCapabilities, err)
	}
	caps.Version = version
	if !caps.Managed() {
		return caps, fmt.Errorf("%w: shared=%t subscribe=%t control=%t approvals=%t convergence=%t reattach=%t",
			ErrClaudeManagedCapabilities,
			caps.SharedAuthority,
			caps.IndependentSubscription,
			caps.SendSteerInterrupt,
			caps.PendingApprovals,
			caps.FirstWriterResolved,
			caps.ReattachAfterRestart,
		)
	}
	return caps, nil
}

func (p ClaudeProbe) classifyError(ctx context.Context, err error) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%w: %v", ErrClaudeProbeTimeout, err)
	}
	return fmt.Errorf("%w: %v", ErrClaudeManagedCapabilities, err)
}
