package memorycontext

import (
	"encoding/json"
	"fmt"
	"strings"
)

// CodexDelivery renders the pack for the managed Codex app-server
// developer-item path (plan 11.3): the hidden context rides an ordered
// developer input item BEFORE the unchanged user text item, tagged with the
// PocketCtl marker so projections can filter it by explicit type.
const CodexDeveloperItemTag = "pocketctl-memory-context"

// CodexContextItem is the developer-role input item carrying the pack.
type CodexContextItem struct {
	Type string `json:"type"`
	Text string `json:"text"`
	Role string `json:"role,omitempty"`
	Tag  string `json:"tag,omitempty"`
}

// BuildCodexInput orders the hidden developer item before the user item.
// The user text is never modified — only preceded.
func BuildCodexInput(pack *PreparedContext, userText string) []map[string]any {
	items := []map[string]any{}
	if pack != nil && (pack.StableText != "" || pack.DynamicText != "") {
		items = append(items, map[string]any{
			"type": "text",
			"role": "developer",
			"tag":  CodexDeveloperItemTag,
			"text": RenderCodexEnvelope(pack),
		})
	}
	items = append(items, map[string]any{"type": "text", "text": userText})
	return items
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
		Role string `json:"role"`
		Tag  string `json:"tag"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return false
	}
	return probe.Role == "developer" && probe.Tag == CodexDeveloperItemTag
}
