package adapter

import (
	"encoding/json"
	"strings"
)

// CodexOriginClassification is the stable agent identity inferred from a
// rollout's creation metadata. Classified is false when the metadata does not
// match a known origin, even though such rollouts continue to use Codex.
type CodexOriginClassification struct {
	AgentType  string
	Classified bool
}

// ClassifyCodexOrigin maps stable rollout metadata to a canonical agent type.
// It deliberately does not inspect the current process, working directory, or
// window title: rollout origin is not the identity of a later opener.
func ClassifyCodexOrigin(meta CodexRolloutMetadata) CodexOriginClassification {
	switch strings.ToLower(strings.TrimSpace(meta.Originator)) {
	case "codex desktop", "codex_work_desktop":
		return CodexOriginClassification{AgentType: AgentCodexDesktop, Classified: true}
	case "codex-tui", "codex_exec", "pocketctl":
		return CodexOriginClassification{AgentType: AgentCodex, Classified: true}
	}

	source, sourceIsString := codexNativeSourceString(meta.NativeSource)
	if sourceIsString && (source == "cli" || source == "exec") {
		return CodexOriginClassification{AgentType: AgentCodex, Classified: true}
	}

	return CodexOriginClassification{AgentType: AgentCodex}
}

func codexNativeSourceString(raw json.RawMessage) (string, bool) {
	var source string
	if len(raw) == 0 || json.Unmarshal(raw, &source) != nil {
		return "", false
	}
	return source, true
}
