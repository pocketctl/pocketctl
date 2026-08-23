package turn

import (
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// golden classification for every production event type registered in v1.
// When a new production type appears it must be added here (or it fails as
// unknown — which is the fail-open signal to add a rule).
func TestClassifyGoldenTable(t *testing.T) {
	dialogueMain := Classification{protocol.ActorScopeRoot, protocol.FlowScopeMain, protocol.ContentClassDialogue}
	interactionMain := Classification{protocol.ActorScopeRoot, protocol.FlowScopeMain, protocol.ContentClassInteraction}
	execAux := Classification{protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassExecution}
	lifecycleAux := Classification{protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassLifecycle}
	telemetryAux := Classification{protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassTelemetry}

	golden := map[string]Classification{
		"user_text":                       dialogueMain,
		"agent_text":                      dialogueMain, // with body — see dedicated test
		"approval_request":                interactionMain,
		"approval_resolved":               interactionMain,
		"question_request":                interactionMain,
		"question_resolved":               interactionMain,
		"mcp_elicitation_request":         interactionMain,
		"mcp_elicitation_resolved":        interactionMain,
		"interactive_prompt":              interactionMain,
		"interaction_result":              interactionMain,
		"agent_reasoning":                 execAux,
		"tool_call":                       execAux,
		"tool_result":                     execAux,
		"agent_patch":                     execAux,
		"agent_file":                      execAux,
		"agent_file_change":               execAux,
		"agent_plan":                      execAux,
		"agent_todo":                      execAux,
		"agent_subtask":                   execAux,
		"agent_profile":                   execAux,
		"session_status":                  lifecycleAux,
		"session_discovered":              lifecycleAux,
		"session_id_changed":              lifecycleAux,
		"session_title_update":            lifecycleAux,
		"session_meta":                    lifecycleAux,
		"session_model_changed":           lifecycleAux,
		"session_agent_changed":           lifecycleAux,
		"session_agent_list":              lifecycleAux,
		"session_created":                 lifecycleAux,
		"session_create_failed":           lifecycleAux,
		"turn_status":                     lifecycleAux,
		"subagent_discovered":             lifecycleAux,
		"daemon_shutdown":                 lifecycleAux,
		"command_receipt":                 lifecycleAux,
		"command_list":                    lifecycleAux,
		"user_message_receipt":            lifecycleAux,
		"generate_title_request":          lifecycleAux,
		"generate_subagent_title_request": lifecycleAux,
		"upgrade_result":                  lifecycleAux,
		"model_list":                      lifecycleAux,
		"permission_config_changed":       lifecycleAux,
		"agent_retry":                     lifecycleAux,
		"agent_compaction":                lifecycleAux,
		"sync_warning":                    lifecycleAux,
		"error":                           lifecycleAux,
		"event_delivery_error":            lifecycleAux,
		"subagent_usage":                  telemetryAux,
	}

	for typ, want := range golden {
		ev := &protocol.DaemonEvent{Type: typ}
		// agent_text golden needs a body to classify as dialogue.
		if typ == "agent_text" {
			ev.Text = "body"
		}
		if got := Classify(ev, nil); got != want {
			t.Errorf("Classify(%s) = %+v, want %+v", typ, got, want)
		}
		if !IsKnownType(typ) {
			t.Errorf("IsKnownType(%s) must be true while it has a golden rule", typ)
		}
	}

	// Every registered rule must be covered by this golden table.
	for typ := range eventRules {
		if _, ok := golden[typ]; !ok {
			t.Errorf("event type %q has a rule but no golden expectation", typ)
		}
	}
}

func TestClassifyAgentTextBodyVsUsageOnly(t *testing.T) {
	withBody := Classify(&protocol.DaemonEvent{Type: "agent_text", Text: "hello"}, nil)
	if withBody.ContentClass != protocol.ContentClassDialogue || withBody.FlowScope != protocol.FlowScopeMain {
		t.Errorf("agent_text with body = %+v, want dialogue/main", withBody)
	}
	usageOnly := Classify(&protocol.DaemonEvent{Type: "agent_text", Usage: &protocol.ContextUsage{TotalTokens: 10}}, nil)
	if usageOnly.ContentClass != protocol.ContentClassTelemetry || usageOnly.FlowScope != protocol.FlowScopeAuxiliary {
		t.Errorf("usage-only agent_text = %+v, want telemetry/auxiliary", usageOnly)
	}
}

func TestClassifyUnknownTypeFailOpenWithCounter(t *testing.T) {
	var unknown []string
	stats := MetricsFuncs{OnUnknownClassification: func(typ string) { unknown = append(unknown, typ) }}
	cls := Classify(&protocol.DaemonEvent{Type: "brand_new_event"}, stats)
	if cls.ContentClass != protocol.ContentClassUnknown || cls.FlowScope != protocol.FlowScopeUnClassified {
		t.Errorf("unknown type = %+v, want unknown/unclassified", cls)
	}
	if len(unknown) != 1 || unknown[0] != "brand_new_event" {
		t.Errorf("unknown counter = %v", unknown)
	}
	if IsKnownType("brand_new_event") {
		t.Error("unregistered type must not be known")
	}
	// The event itself is never filtered — Classify returns metadata only.
	if cls.ActorScope != protocol.ActorScopeRoot {
		t.Errorf("unknown events still get an actor scope, got %q", cls.ActorScope)
	}
}

func TestClassifyNilEvent(t *testing.T) {
	cls := Classify(nil, nil)
	if cls.ActorScope != protocol.ActorScopeUnknown || cls.ContentClass != protocol.ContentClassUnknown {
		t.Errorf("nil event = %+v, want unknown/unknown", cls)
	}
}

func TestClassifyActorScopeSubagent(t *testing.T) {
	ev := &protocol.DaemonEvent{Type: "agent_text", Text: "sub reply", AgentID: "agent-7", IsSubagent: true}
	cls := Classify(ev, nil)
	if cls.ActorScope != protocol.ActorScopeSubagent {
		t.Errorf("actor scope = %q, want subagent", cls.ActorScope)
	}
	if cls.FlowScope != protocol.FlowScopeMain || cls.ContentClass != protocol.ContentClassDialogue {
		t.Errorf("subagent final answer = %+v, want main/dialogue", cls)
	}
	// Classification never rewrites the hierarchy fields.
	if ev.AgentID != "agent-7" || !ev.IsSubagent {
		t.Error("classifier must not mutate hierarchy fields")
	}
}

func TestApplyStampsOnlyClassificationFields(t *testing.T) {
	ev := &protocol.DaemonEvent{Type: "tool_call", CallID: "call-1", SessionID: "s"}
	before := *ev
	Apply(ev, Classification{protocol.ActorScopeRoot, protocol.FlowScopeAuxiliary, protocol.ContentClassExecution})
	if ev.ActorScope != protocol.ActorScopeRoot || ev.FlowScope != protocol.FlowScopeAuxiliary ||
		ev.ContentClass != protocol.ContentClassExecution || ev.ClassifierVersion != "v1" {
		t.Errorf("Apply did not stamp classification: %+v", ev)
	}
	ev.ActorScope, ev.FlowScope, ev.ContentClass, ev.ClassifierVersion = "", "", "", ""
	if ev.Type != before.Type || ev.CallID != before.CallID || ev.SessionID != before.SessionID {
		t.Error("Apply must not touch other fields")
	}
	Apply(nil, Classification{}) // must not panic
}
