// Package usageanalytics contains source evidence only; it never parses agent prose.
package usageanalytics

import "github.com/pocketctl/pocketctl/internal/protocol"

func Metadata(provider, identity, request, occurred, model, semantics string, revision int64) *protocol.UsageMetadata {

	return &protocol.UsageMetadata{Version: 1, Provider: provider, SourceUsageID: identity, RequestID: request, OccurredAt: occurred, Model: model, InputSemantics: semantics, Revision: revision, Mode: "cumulative"}
}

// Enrich attaches only native identities. Unknown cache semantics stay unknown
// independently from available model, source time, and tool lifecycle evidence.
func Enrich(events []protocol.DaemonEvent, provider, identity, occurred, model, semantics string, revision int64, resultKnown bool) {
	for i := range events {
		e := &events[i]
		if e.Usage != nil {
			e.UsageMeta = Metadata(provider, identity, "", occurred, model, semantics, revision)
			if e.UsageMeta != nil {
				e.UsageMeta.AgentType = provider
			}
		}
		if (e.Type == "tool_call" || e.Type == "tool_result") && e.CallID != "" {
			outcome := "unknown"
			if e.Type == "tool_result" && resultKnown {
				outcome = "success"
				if e.Error != "" || e.Status == "error" {
					outcome = "failure"
				}
			}
			e.CallMeta = &protocol.CallMetadata{Version: 1, InvocationID: e.CallID, Revision: revision, ToolKind: "unknown", ToolName: e.Tool, OccurredAt: occurred, Outcome: outcome, EvidenceKind: "native_tool_lifecycle"}
		}
	}
}
