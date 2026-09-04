package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Turn v1 contract fixtures freeze the cross-agent lifecycle semantics defined in
// docs/plans/2026-08-20-turn-lifecycle-and-stream-classification.md before any
// production protocol change. The fixtures deliberately carry the planned v1
// optional fields (turn_* / actor_scope / flow_scope / content_class /
// classifier_version) that DaemonEvent does not declare yet in stage 0, so
// decoding them through DaemonEvent also proves the "old client ignores
// unknown optional fields" compatibility contract.

// turnV1OptionalFields is the frozen stage-1 field set from plan §4.
var turnV1OptionalFields = []string{
	"source_turn_id",
	"turn_status",
	"turn_reason",
	"turn_origin",
	"turn_confidence",
	"previous_turn_id",
	"continuation_reason",
	"actor_scope",
	"flow_scope",
	"content_class",
	"classifier_version",
}

// These labels select parser contracts, not distinct fixture identities.
// codex-desktop deliberately re-runs the Codex parser fixture because Desktop
// rollouts use that parser. Its distinct public agent identity and observer
// policy are asserted by the cross-layer E2E, not by this fixture alias.
var turnV1ParserContractLabels = []string{"claude-code", "codex", "codex-desktop", "opencode", "zcode"}

// Every parser-contract label must cover the canonical lifecycle scenarios; the
// legacy_unassigned scenario marks a reviewed gap where no stable source
// identity exists (never silently guessed into a turn).
var turnV1RequiredScenarios = []string{
	"completed", "interrupted", "failed", "addendum", "subagent", "legacy_unassigned",
}

var (
	turnV1States      = []string{"running", "interrupt_requested", "completed", "interrupted", "failed", "abandoned"}
	turnV1Origins     = []string{"native", "request", "source_message", "legacy_unassigned"}
	turnV1Confidences = []string{"native", "derived", "inferred"}
	turnV1ActorScopes = []string{"root", "subagent", "unknown"}
	turnV1FlowScopes  = []string{"main", "auxiliary", "unclassified"}
	turnV1ContentCls  = []string{"dialogue", "execution", "interaction", "lifecycle", "telemetry", "unknown"}
)

type turnFixtureScenario struct {
	Name        string                   `json:"name"`
	Expectation string                   `json:"expectation"`
	Notes       string                   `json:"notes,omitempty"`
	Events      []map[string]interface{} `json:"events"`
}

type turnFixtureFile struct {
	Agent     string                `json:"agent"`
	Scenarios []turnFixtureScenario `json:"scenarios"`
}

func turnV1ParserFixtureAgent(contractLabel string) string {
	if contractLabel == "codex-desktop" {
		return "codex"
	}
	return contractLabel
}

func loadTurnFixture(t *testing.T, contractLabel string) turnFixtureFile {
	t.Helper()
	fixtureAgent := turnV1ParserFixtureAgent(contractLabel)
	raw, err := os.ReadFile(filepath.Join("testdata", "turn-v1", fixtureAgent+".json"))
	if err != nil {
		t.Fatalf("read turn-v1 parser fixture for contract %s: %v", contractLabel, err)
	}
	var f turnFixtureFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse turn-v1 fixture for contract %s: %v", contractLabel, err)
	}
	if f.Agent != fixtureAgent {
		t.Fatalf("fixture agent field %q does not match parser contract %q selected by label %q", f.Agent, fixtureAgent, contractLabel)
	}
	return f
}

func turnFixtureText(t *testing.T, contractLabel string) string {
	t.Helper()
	fixtureAgent := turnV1ParserFixtureAgent(contractLabel)
	raw, err := os.ReadFile(filepath.Join("testdata", "turn-v1", fixtureAgent+".json"))
	if err != nil {
		t.Fatalf("read turn-v1 parser fixture for contract %s: %v", contractLabel, err)
	}
	return string(raw)
}

func loadAllTurnFixtures(t *testing.T) map[string]turnFixtureFile {
	t.Helper()
	out := make(map[string]turnFixtureFile, len(turnV1ParserContractLabels))
	for _, agent := range turnV1ParserContractLabels {
		out[agent] = loadTurnFixture(t, agent)
	}
	return out
}

func strField(ev map[string]interface{}, key string) string {
	if v, ok := ev[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func allowedValue(list []string, got string) bool {
	for _, v := range list {
		if v == got {
			return true
		}
	}
	return false
}

// 1. Inventory: every parser-contract label covers the canonical scenarios with parseable,
// non-empty event streams.
func TestTurnV1FixtureInventory(t *testing.T) {
	for _, agent := range turnV1ParserContractLabels {
		fixture := loadTurnFixture(t, agent)
		seen := make(map[string]bool)
		for _, sc := range fixture.Scenarios {
			if sc.Name == "" || sc.Expectation == "" {
				t.Fatalf("%s: scenario with empty name/expectation: %+v", agent, sc)
			}
			if len(sc.Events) == 0 {
				t.Fatalf("%s/%s: scenario has no events", agent, sc.Name)
			}
			for i, ev := range sc.Events {
				if strField(ev, "type") == "" {
					t.Fatalf("%s/%s: event %d has no type", agent, sc.Name, i)
				}
				if strField(ev, "session_id") == "" {
					t.Fatalf("%s/%s: event %d (%s) has no session_id", agent, sc.Name, i, strField(ev, "type"))
				}
			}
			seen[sc.Expectation] = true
		}
		for _, want := range turnV1RequiredScenarios {
			if !seen[want] {
				t.Errorf("%s: missing required scenario expectation %q (covered: %v)", agent, want, seen)
			}
		}
	}
}

// 2. Sanitization: no absolute user directories, no secret-looking material,
// and every text body is explicitly synthetic.
func TestTurnV1FixturesSanitized(t *testing.T) {
	home, _ := os.UserHomeDir()
	for _, agent := range turnV1ParserContractLabels {
		text := turnFixtureText(t, agent)
		for _, banned := range []string{"/Users/", "/home/", home + "/"} {
			if banned != "/" && strings.Contains(text, banned) {
				t.Errorf("%s: fixture contains absolute user directory %q", agent, banned)
			}
		}
		for _, banned := range []string{"sk-", "ghp_", "api_key", "Bearer "} {
			if strings.Contains(text, banned) {
				t.Errorf("%s: fixture contains secret-looking material %q", agent, banned)
			}
		}
		fixture := loadTurnFixture(t, agent)
		for _, sc := range fixture.Scenarios {
			for i, ev := range sc.Events {
				for _, body := range []string{"text", "output", "prompt", "error"} {
					if v := strField(ev, body); v != "" && !strings.Contains(strings.ToLower(v), "fixture") {
						t.Errorf("%s/%s: event %d field %s is not synthetic: %q", agent, sc.Name, i, body, v)
					}
				}
				if p := strField(ev, "path"); p != "" && strings.HasPrefix(p, "/") {
					t.Errorf("%s/%s: event %d has absolute path %q", agent, sc.Name, i, p)
				}
			}
		}
	}
}

// 3. Legacy-client compatibility: stripping the v1 optional fields must yield a
// payload the current (pre-v1) DaemonEvent decodes identically, and the raw
// payload with unknown fields must also decode without error.
func TestTurnV1LegacyClientCompatibility(t *testing.T) {
	for _, agent := range turnV1ParserContractLabels {
		fixture := loadTurnFixture(t, agent)
		for _, sc := range fixture.Scenarios {
			for i, ev := range sc.Events {
				raw, err := json.Marshal(ev)
				if err != nil {
					t.Fatalf("%s/%s: marshal event %d: %v", agent, sc.Name, i, err)
				}
				var full DaemonEvent
				if err := json.Unmarshal(raw, &full); err != nil {
					t.Fatalf("%s/%s: event %d with v1 fields does not decode as legacy DaemonEvent: %v", agent, sc.Name, i, err)
				}
				stripped := make(map[string]interface{}, len(ev))
				for k, v := range ev {
					stripped[k] = v
				}
				for _, drop := range turnV1OptionalFields {
					delete(stripped, drop)
				}
				legacyRaw, err := json.Marshal(stripped)
				if err != nil {
					t.Fatalf("%s/%s: marshal stripped event %d: %v", agent, sc.Name, i, err)
				}
				var legacy DaemonEvent
				if err := json.Unmarshal(legacyRaw, &legacy); err != nil {
					t.Fatalf("%s/%s: stripped event %d does not decode: %v", agent, sc.Name, i, err)
				}
				if full.Type != legacy.Type || full.SessionID != legacy.SessionID || full.EventID != legacy.EventID {
					t.Errorf("%s/%s: event %d legacy view changed identity (type/session/event_id)", agent, sc.Name, i)
				}
			}
		}
	}
}

// 4. Source-identity evidence: each non-legacy scenario must carry at least one
// stable identity anchor for its parser contract; legacy scenarios stay unassigned.
func TestTurnV1SourceIdentityEvidence(t *testing.T) {
	for _, agent := range turnV1ParserContractLabels {
		fixture := loadTurnFixture(t, agent)
		for _, sc := range fixture.Scenarios {
			hasTurnID := false
			agentEvidence := false
			for _, ev := range sc.Events {
				if strField(ev, "turn_id") != "" {
					hasTurnID = true
				}
				switch agent {
				case "codex", "codex-desktop":
					agentEvidence = agentEvidence || strField(ev, "source_turn_id") != ""
				case "opencode":
					agentEvidence = agentEvidence || strField(ev, "message_id") != ""
				case "claude-code":
					agentEvidence = agentEvidence || strField(ev, "event_id") != "" || strField(ev, "request_id") != ""
				case "zcode":
					agentEvidence = agentEvidence || strField(ev, "part_id") != "" || strField(ev, "event_id") != ""
				}
			}
			if sc.Expectation == "legacy_unassigned" {
				for i, ev := range sc.Events {
					if strField(ev, "turn_id") != "" {
						t.Errorf("%s/%s: legacy scenario event %d must not carry turn_id", agent, sc.Name, i)
					}
					if o := strField(ev, "turn_origin"); o != "" && o != "legacy_unassigned" {
						t.Errorf("%s/%s: legacy scenario event %d has turn_origin=%q", agent, sc.Name, i, o)
					}
				}
				continue
			}
			if !hasTurnID {
				t.Errorf("%s/%s: no event carries a turn_id", agent, sc.Name)
			}
			if !agentEvidence {
				t.Errorf("%s/%s: no stable source-identity evidence (%s-specific)", agent, sc.Name, agent)
			}
			for i, ev := range sc.Events {
				if o := strField(ev, "turn_origin"); o != "" && !allowedValue(turnV1Origins, o) {
					t.Errorf("%s/%s: event %d has unknown turn_origin %q", agent, sc.Name, i, o)
				}
			}
		}
	}
}

// 5. turn_status event shape: minimal field set, deterministic event_id suffix
// matching the emitted state, frozen vocabularies, and at most one emission per
// (turn_id, state) inside a scenario.
func TestTurnV1TurnStatusEventContract(t *testing.T) {
	for _, agent := range turnV1ParserContractLabels {
		fixture := loadTurnFixture(t, agent)
		for _, sc := range fixture.Scenarios {
			emitted := make(map[string]bool)
			for i, ev := range sc.Events {
				if strField(ev, "type") != "turn_status" {
					continue
				}
				for _, required := range []string{"session_id", "turn_id", "turn_status", "turn_origin", "turn_confidence", "actor_scope", "event_id"} {
					if _, ok := ev[required]; !ok {
						t.Errorf("%s/%s: turn_status event %d missing required key %q", agent, sc.Name, i, required)
					}
				}
				state := strField(ev, "turn_status")
				if !allowedValue(turnV1States, state) {
					t.Errorf("%s/%s: turn_status event %d has invalid state %q", agent, sc.Name, i, state)
				}
				id := strField(ev, "turn_id")
				key := id + "|" + state
				if emitted[key] {
					t.Errorf("%s/%s: duplicate turn_status emission for %s", agent, sc.Name, key)
				}
				emitted[key] = true
				wantSuffix := ":status:" + state
				eid := strField(ev, "event_id")
				if !strings.HasPrefix(eid, "turn:") || !strings.HasSuffix(eid, wantSuffix) {
					t.Errorf("%s/%s: turn_status event %d event_id %q must be turn:<hash>%s", agent, sc.Name, i, eid, wantSuffix)
				}
			}
		}
	}
}

// 6. Frozen vocabularies: every classification field value in the fixtures
// belongs to the stage-1 closed sets from plan §1/§4.
func TestTurnV1Vocabulary(t *testing.T) {
	fixtures := loadAllTurnFixtures(t)
	for agent, fixture := range fixtures {
		for _, sc := range fixture.Scenarios {
			for i, ev := range sc.Events {
				checks := []struct {
					key string
					set []string
				}{
					{"turn_confidence", turnV1Confidences},
					{"actor_scope", turnV1ActorScopes},
					{"flow_scope", turnV1FlowScopes},
					{"content_class", turnV1ContentCls},
				}
				for _, c := range checks {
					if v := strField(ev, c.key); v != "" && !allowedValue(c.set, v) {
						t.Errorf("%s/%s: event %d has %s=%q outside frozen vocabulary", agent, sc.Name, i, c.key, v)
					}
				}
				if cv := strField(ev, "classifier_version"); cv != "" && cv != "v1" {
					t.Errorf("%s/%s: event %d has classifier_version=%q, want v1", agent, sc.Name, i, cv)
				}
			}
		}
	}
}

// 7. Interrupt ordering freeze (plan §3.3 scenario A): within any scenario that
// ends in interruption plus session exit, turn terminal state must be observed
// before the session exit status.
func TestTurnV1InterruptThenExitOrdering(t *testing.T) {
	for _, agent := range turnV1ParserContractLabels {
		fixture := loadTurnFixture(t, agent)
		for _, sc := range fixture.Scenarios {
			var turnTerminalIdx, sessionExitIdx = -1, -1
			for i, ev := range sc.Events {
				if strField(ev, "type") == "turn_status" && allowedValue([]string{"interrupted", "failed", "abandoned"}, strField(ev, "turn_status")) {
					if turnTerminalIdx == -1 {
						turnTerminalIdx = i
					}
				}
				if strField(ev, "type") == "session_status" && allowedValue([]string{"exited", "completed", "error", "killed"}, strField(ev, "status")) {
					if sessionExitIdx == -1 {
						sessionExitIdx = i
					}
				}
			}
			if turnTerminalIdx != -1 && sessionExitIdx != -1 && turnTerminalIdx > sessionExitIdx {
				t.Errorf("%s/%s: turn terminal event (%d) must precede session exit (%d)", agent, sc.Name, turnTerminalIdx, sessionExitIdx)
			}
		}
	}
}

// 8. Continuation freeze (plan §3.3 scenario B): a post-interrupt new turn must
// reference the old turn and must not inherit pending interactions.
func TestTurnV1PostInterruptContinuation(t *testing.T) {
	fixtures := loadAllTurnFixtures(t)
	found := false
	for agent, fixture := range fixtures {
		for _, sc := range fixture.Scenarios {
			var interruptedTurn string
			for _, ev := range sc.Events {
				if strField(ev, "type") == "turn_status" && strField(ev, "turn_status") == "interrupted" && interruptedTurn == "" {
					interruptedTurn = strField(ev, "turn_id")
				}
				if interruptedTurn != "" && strField(ev, "previous_turn_id") == interruptedTurn {
					found = true
					if strField(ev, "continuation_reason") != "after_interrupt" {
						t.Errorf("%s/%s: continuation of %s has reason %q, want after_interrupt", agent, sc.Name, interruptedTurn, strField(ev, "continuation_reason"))
					}
				}
			}
		}
	}
	if !found {
		t.Error("no fixture demonstrates post-interrupt continuation with previous_turn_id")
	}
}

// Guard against accidental fixture sprawl: event types used in fixtures must be
// real production DaemonEvent types (spot-check the core set every agent uses).
func TestTurnV1FixtureEventTypesAreReal(t *testing.T) {
	known := map[string]bool{
		"user_text": true, "agent_text": true, "agent_reasoning": true,
		"tool_call": true, "tool_result": true, "turn_status": true,
		"session_status": true, "session_discovered": true, "subagent_discovered": true,
		"agent_retry": true, "agent_compaction": true, "agent_subtask": true,
		"agent_plan": true, "agent_file_change": true, "approval_request": true,
		"approval_resolved": true, "question_request": true, "question_resolved": true,
		"user_message_receipt": true, "agent_todo": true, "error": true,
	}
	for _, agent := range turnV1ParserContractLabels {
		fixture := loadTurnFixture(t, agent)
		for _, sc := range fixture.Scenarios {
			for i, ev := range sc.Events {
				typ := strField(ev, "type")
				if !known[typ] {
					t.Errorf("%s/%s: event %d uses non-production type %q", agent, sc.Name, i, typ)
				}
			}
		}
	}
}
