package memorycontext

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
)

// CodexDeveloperItemTag identifies native developer history owned by PocketCtl.
const CodexDeveloperItemTag = "pocketctl-memory-context"

// BuildCodexInput preserves the normal UserInput contract. Hidden context
// must be sent separately through thread/inject_items, which accepts raw
// Responses items; turn/start text items do not support a developer role.
func BuildCodexInput(_ *PreparedContext, userText string) []map[string]any {
	return []map[string]any{{"type": "text", "text": userText}}
}

func BuildCodexHistoryItems(pack *PreparedContext) []map[string]any {
	if pack == nil || (pack.StableText == "" && pack.DynamicText == "") {
		return nil
	}
	envelope := RenderCodexEnvelope(pack)
	id := pack.PackID
	if id == "" {
		hash := sha256.Sum256([]byte(envelope))
		id = hex.EncodeToString(hash[:])
	}
	return []map[string]any{{
		"type": "message", "id": CodexDeveloperItemTag + ":" + id, "role": "developer",
		"content": []map[string]any{{"type": "input_text", "text": envelope}},
	}}
}

// RenderCodexEnvelope renders the stable and dynamic sections with the
// PocketCtl marker the projection layer keys on.
func RenderCodexEnvelope(pack *PreparedContext) string {
	var b strings.Builder
	b.WriteString("<pocketctl_memory_context schema=\"1\"")
	if pack.PackID != "" {
		fmt.Fprintf(&b, " pack_id=%q", pack.PackID)
	}
	b.WriteString(">\n")
	if pack.StableText != "" {
		b.WriteString("[stable]\n")
		b.WriteString(pack.StableText)
		b.WriteString("\n")
	}
	if pack.DynamicText != "" {
		b.WriteString("[dynamic]\n")
		b.WriteString(pack.DynamicText)
		b.WriteString("\n")
	}
	b.WriteString("</pocketctl_memory_context>")
	return b.String()
}

// IsCodexContextItem reports whether a raw input item is the synthetic
// developer context — matched by explicit role+tag, never by text matching.
func IsCodexContextItem(raw json.RawMessage) bool {
	var probe struct {
		Type string `json:"type"`
		ID   string `json:"id"`
		Role string `json:"role"`
		Tag  string `json:"tag"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return false
	}
	return probe.Role == "developer" && (probe.Tag == CodexDeveloperItemTag ||
		(probe.Type == "message" && strings.HasPrefix(probe.ID, CodexDeveloperItemTag+":") && len(probe.ID) > len(CodexDeveloperItemTag)+1))
}
