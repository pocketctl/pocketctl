package turn

import (
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Classification is the v1 metadata added to an outgoing event. It never
// filters, reorders or rewrites the event — enrichment only.
type Classification struct {
	ActorScope   string
	FlowScope    string
	ContentClass string
}

// Stats observes classifier outcomes. Unknown-type counting happens here so
// Classify itself stays a pure function; a nil Stats is valid.
type Stats interface {
	UnknownClassification(eventType string)
}

// eventRules is the exhaustive v1 registry of production DaemonEvent types.
// Anything absent here classifies as unknown/unclassified and is still
// transmitted unchanged (fail-open, plan §4).
var eventRules = map[string]Classification{
	// dialogue / main
	"user_text": {protocol.ActorScopeRoot, protocol.FlowScopeMain, protocol.ContentClassDialogue},
	// agent_text is context-dependent (dialogue with body vs telemetry
	// usage-only) and resolved inside Classify.

	// interaction / main — never folded or deprioritized by any consumer.
	"approval_request":         {protocol.ActorScopeRoot, protocol.FlowScopeMain, protocol.ContentClassInteraction},
	"approval_resolved":        {protocol.ActorScopeRoot, protocol.FlowScopeMain, protocol.ContentClassInteraction},
	"question_request":         {protocol.ActorScopeRoot, protocol.FlowScopeMain, protocol.ContentClassInteraction},
	"question_resolved":        {protocol.ActorScopeRoot, protocol.FlowScopeMain, protocol.ContentClassInteraction},
	"mcp_elicitation_request":  {protocol.ActorScopeRoot, protocol.FlowScopeMain, protocol.ContentClassInteraction},
	"mcp_elicitation_resolved": {protocol.ActorScopeRoot, protocol.FlowScopeMain, protocol.ContentClassInteraction},
	"interactive_prompt":       {protocol.ActorScopeRoot, protocol.FlowScopeMain, protocol.ContentClassInteraction},
	"interaction_result":       {protocol.ActorScopeRoot, protocol.FlowScopeMain, protocol.ContentClassInteraction},

	// execution / auxiliary — metadata only, never dropped.
	"agent_reasoning":   {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassExecution},
	"tool_call":         {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassExecution},
	"tool_result":       {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassExecution},
	"agent_patch":       {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassExecution},
	"agent_file":        {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassExecution},
	"agent_file_change": {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassExecution},
	"agent_plan":        {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassExecution},
	"agent_todo":        {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassExecution},
	"agent_subtask":     {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassExecution},
	"agent_profile":     {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassExecution},

	// lifecycle / auxiliary — persisted as control flow.
	"session_status":                  {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"session_discovered":              {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"session_id_changed":              {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"session_title_update":            {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"session_meta":                    {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"session_model_changed":           {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"session_agent_changed":           {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"session_agent_list":              {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"session_created":                 {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"session_create_failed":           {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"turn_status":                     {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"subagent_discovered":             {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"daemon_shutdown":                 {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"command_receipt":                 {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"command_list":                    {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"user_message_receipt":            {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"generate_title_request":          {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"generate_subagent_title_request": {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"upgrade_result":                  {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"model_list":                      {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"permission_config_changed":       {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"agent_retry":                     {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"agent_compaction":                {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"sync_warning":                    {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"error":                           {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},
	"event_delivery_error":            {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle},

	// telemetry / auxiliary — usage/cost-only statistics.
	"subagent_usage": {protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassTelemetry},
}

// IsKnownType reports whether typ has an explicit v1 rule (or a
// context-dependent rule resolved by Classify).
func IsKnownType(typ string) bool {
	if typ == "agent_text" {
		return true
	}
	_, ok := eventRules[typ]
	return ok
}

// Classify returns the v1 classification for ev. actor_scope is derived only
// from existing agent hierarchy fields; flow/content classes never rewrite
// them. Unknown types return unknown/unclassified and, when stats is non-nil,
// increment the unknown-classification counter.
func Classify(ev *protocol.DaemonEvent, stats Stats) Classification {
	if ev == nil {
		if stats != nil {
			stats.UnknownClassification("<nil>")
		}
		return Classification{
			ActorScope:   protocol.ActorScopeUnknown,
			FlowScope:    protocol.FlowScopeUnClassified,
			ContentClass: protocol.ContentClassUnknown,
		}
	}
	cls := Classification{
		ActorScope:   ActorScope(ev.AgentID, ev.IsSubagent),
		FlowScope:    protocol.FlowScopeUnClassified,
		ContentClass: protocol.ContentClassUnknown,
	}
	if rule, ok := eventRules[ev.Type]; ok {
		cls.FlowScope = rule.FlowScope
		cls.ContentClass = rule.ContentClass
		return cls
	}
	if ev.Type == "agent_text" {
		// Dialogue when there is body text; usage/cost-only frames are
		// telemetry and must never masquerade as dialogue (plan §4).
		if ev.Text != "" {
			cls.FlowScope = protocol.FlowScopeMain
			cls.ContentClass = protocol.ContentClassDialogue
		} else {
			cls.FlowScope = protocol.FlowScopeAuxiliary
			cls.ContentClass = protocol.ContentClassTelemetry
		}
		return cls
	}
	if stats != nil {
		stats.UnknownClassification(ev.Type)
	}
	return cls
}

// Apply stamps the classification metadata onto ev without touching any other
// field. Caller owns emission.
func Apply(ev *protocol.DaemonEvent, cls Classification) {
	if ev == nil {
		return
	}
	ev.ActorScope = cls.ActorScope
	ev.FlowScope = cls.FlowScope
	ev.ContentClass = cls.ContentClass
	ev.ClassifierVersion = protocol.ClassifierVersionV1
}
