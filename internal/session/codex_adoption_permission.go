package session

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"

	"path/filepath"
	"slices"
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Codex can select the current home's sandbox on thread/resume even when the
// original turn ran under a narrower sandbox. The original native turn is
// the upper bound, including on hosts that allow dangerous remote settings.
type adoptionSandboxLimit struct {
	Cwd        string `json:"cwd"`
	Approval   string `json:"approval_policy"`
	Reviewer   string `json:"approvals_reviewer"`
	FilePolicy struct {
		Type    string `json:"type"`
		Entries []struct {
			Path struct {
				Type  string `json:"type"`
				Path  string `json:"path"`
				Value struct {
					Kind string `json:"kind"`
				} `json:"value"`
			} `json:"path"`
			Access string `json:"access"`
		} `json:"entries"`
	} `json:"file_system_sandbox_policy"`
	Sandbox struct {
		Type          string          `json:"type"`
		WritableRoots []string        `json:"writable_roots"`
		Network       bool            `json:"network_access"`
		ExcludeEnv    bool            `json:"exclude_tmpdir_env_var"`
		ExcludeTmp    bool            `json:"exclude_slash_tmp"`
		Access        json.RawMessage `json:"access"`
	} `json:"sandbox_policy"`
}

func lastAdoptionSandbox(ctx context.Context, source io.Reader) *adoptionSandboxLimit {
	reader := bufio.NewReaderSize(source, 64*1024)
	var last *adoptionSandboxLimit
	for ctx.Err() == nil {
		part, err := reader.ReadSlice('\n')
		if err == bufio.ErrBufferFull {
			// A tool transcript can be arbitrarily large. Its native envelope
			// identifies it before the payload. Keep memory bounded.
			kind := adoptionEnvelopeType(part)
			if kind == "turn_context" || kind == "" {
				last = nil
			}
			for err == bufio.ErrBufferFull && ctx.Err() == nil {
				_, err = reader.ReadSlice('\n')
			}
		} else if bytes.Contains(part, []byte(`"turn_context"`)) {
			var entry struct {
				Type    string
				Payload adoptionSandboxLimit
			}
			if json.Unmarshal(part, &entry) == nil {
				if entry.Type == "turn_context" {
					last = &entry.Payload
				}
			} else if adoptionEnvelopeType(part) == "turn_context" {
				last = nil
			}
		}
		if err == io.EOF {
			return last
		}
		if err != nil {
			return nil
		}
	}
	return nil
}

func adoptionEnvelopeType(prefix []byte) string {
	dec := json.NewDecoder(bytes.NewReader(prefix))
	if _, err := dec.Token(); err != nil {
		return ""
	}
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return ""
		}
		var value string
		if key != "timestamp" && key != "type" {
			return ""
		}
		if dec.Decode(&value) != nil {
			return ""
		}
		if key == "type" {
			return value
		}
	}
	return ""
}

func (p *adoptionSandboxLimit) allows(current *protocol.PermissionConfig, cwd string, native codexNativeConfigFields) bool {
	if p == nil || current == nil {
		return false
	}
	approval := []string{"untrusted", "on-request", "never"}
	sandbox := []string{"read-only", "workspace-write", "danger-full-access"}
	oldApproval, newApproval := slices.Index(approval, p.Approval), slices.Index(approval, current.ApprovalPolicy)
	oldSandbox, newSandbox := slices.Index(sandbox, p.Sandbox.Type), slices.Index(sandbox, current.SandboxMode)
	if oldApproval < 0 || newApproval < 0 || newApproval > oldApproval || oldSandbox < 0 || newSandbox < 0 || newSandbox > oldSandbox {
		return false
	}
	if native.ApprovalsReviewer != "" && native.ApprovalsReviewer != "user" && native.ApprovalsReviewer != p.Reviewer {
		return false
	}
	// The resume response exposes the legacy sandbox summary. Named or custom
	// per-path restrictions that the summary cannot attest must remain read-only.
	if !p.representableFilePolicy(newSandbox) {
		return false
	}
	if oldSandbox == 2 {
		return true
	}
	if !p.Sandbox.Network && native.Sandbox.NetworkAccess {
		return false
	}
	if len(p.Sandbox.Access) > 0 && string(p.Sandbox.Access) != "null" {
		// Restricted read allowlists must be preserved exactly. The native
		// protocol has used both snake-case and camel-case enum spellings.
		normalize := func(v json.RawMessage) any {
			var result any
			raw := strings.ReplaceAll(string(v), `"full-access"`, `"fullAccess"`)
			if json.Unmarshal([]byte(raw), &result) != nil {
				return nil
			}
			return result
		}
		previous, _ := json.Marshal(normalize(p.Sandbox.Access))
		next, _ := json.Marshal(normalize(native.Sandbox.Access))
		if !bytes.Equal(previous, next) {
			return false
		}
	}
	if newSandbox == 0 {
		return true
	}
	if p.Sandbox.ExcludeEnv && !native.Sandbox.ExcludeTmpdirEnvVar || p.Sandbox.ExcludeTmp && !native.Sandbox.ExcludeSlashTmp {
		return false
	}
	base, err := filepath.EvalSymlinks(p.Cwd)
	if err != nil {
		return false
	}
	currentCwd, err := filepath.EvalSymlinks(cwd)
	if err != nil || base != currentCwd {
		return false
	}
	for _, added := range native.Sandbox.WritableRoots {
		clean, err := filepath.EvalSymlinks(added)
		if err != nil || !filepath.IsAbs(clean) {
			return false
		}
		allowed := isSubPath(base, clean)
		for _, original := range p.Sandbox.WritableRoots {
			resolved, err := filepath.EvalSymlinks(original)
			if err == nil && filepath.IsAbs(resolved) && isSubPath(resolved, clean) {
				allowed = true
				break
			}
		}
		if !allowed {
			return false
		}
	}
	return true
}

func (p *adoptionSandboxLimit) representableFilePolicy(currentRank int) bool {
	if p.FilePolicy.Type == "" || p.FilePolicy.Type == "unrestricted" {
		return true
	}
	if p.FilePolicy.Type != "restricted" {
		return false
	}
	rootReadable := false
	for _, entry := range p.FilePolicy.Entries {
		switch entry.Access {
		case "write": // The native sandbox summary is separately checked for new writes.
		case "read":
			if entry.Path.Type == "special" && entry.Path.Value.Kind == "root" {
				rootReadable = true
				continue
			}
			if currentRank == 0 {
				continue
			}
			// Codex's standard workspace-write sandbox protects these metadata
			// directories even when its parent directory is writable.
			rel, err := filepath.Rel(p.Cwd, entry.Path.Path)
			if entry.Path.Type != "path" || err != nil || !slices.Contains([]string{".git", ".agents", ".codex", ".aws"}, rel) {
				return false
			}
		default:
			return false
		}
	}
	// A restricted read allowlist is richer than the protocol's readOnly mode.
	return rootReadable
}
