package memorycontext

import "strings"

// OpenCodeDelivery carries the pack through the per-message `system` field
// (plan 11.3): stable prefix then dynamic suffix, both marked with the
// PocketCtl envelope so projections filter by marker, never by user text.
func BuildOpenCodeSystem(pack *PreparedContext) string {
	if pack == nil || (pack.StableText == "" && pack.DynamicText == "") {
		return ""
	}
	return RenderCodexEnvelope(pack)
}

// SplitOpenCodeSystem is the projection-side inverse: it reports whether a
// system string is the synthetic context envelope.
func IsOpenCodeSystem(system string) bool {
	return strings.Contains(system, "<pocketctl_memory_context")
}
