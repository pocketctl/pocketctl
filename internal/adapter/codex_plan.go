package adapter

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

const (
	codexPlanMaxInputBytes       = 256 * 1024
	codexPlanMaxItems            = 100
	codexPlanMaxStepBytes        = 4096
	codexPlanMaxExplanationBytes = 8192
)

type codexPlanPayload struct {
	Explanation string
	Plan        []protocol.PlanItem
}

type codexPlanIdentity struct {
	EventID         string
	PreviousEventID string
	Revision        int
}

type codexPlanTracker struct {
	mu          sync.Mutex
	lastEventID string
	revision    int
	seen        map[string]codexPlanIdentity
	order       []string
}

func (t *codexPlanTracker) project(callID string, payload codexPlanPayload) protocol.DaemonEvent {
	t.mu.Lock()
	defer t.mu.Unlock()
	if identity, ok := t.seen[callID]; ok {
		return codexPlanEvent(identity, payload)
	}
	identity := codexPlanIdentity{
		EventID:         "codex:plan:" + callID,
		PreviousEventID: t.lastEventID,
		Revision:        t.revision + 1,
	}
	if t.seen == nil {
		t.seen = make(map[string]codexPlanIdentity)
	}
	const maxRememberedPlanCalls = 256
	if len(t.order) == maxRememberedPlanCalls {
		delete(t.seen, t.order[0])
		copy(t.order, t.order[1:])
		t.order = t.order[:maxRememberedPlanCalls-1]
	}
	t.seen[callID] = identity
	t.order = append(t.order, callID)
	t.lastEventID = identity.EventID
	t.revision = identity.Revision
	return codexPlanEvent(identity, payload)
}

// CodexPlanState keeps Plan identity continuous across the short-lived
// subprocesses used to resume one Codex session.
type CodexPlanState struct {
	tracker codexPlanTracker
}

func NewCodexPlanState() *CodexPlanState { return &CodexPlanState{} }

// LoadCodexPlanState rebuilds Plan identity from an existing rollout so a
// daemon restart can continue the same revision chain on the next resume.
func LoadCodexPlanState(path string) (*CodexPlanState, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	state := NewCodexPlanState()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		// Rollouts can contain records from newer Codex versions. Ignore shapes
		// this adapter does not understand while retaining recognized Plan calls.
		_, _ = parseCodexLine(scanner.Text(), nil, &state.tracker)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan codex rollout plan state: %w", err)
	}
	return state, nil
}

func codexPlanEvent(identity codexPlanIdentity, payload codexPlanPayload) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type:            "agent_plan",
		EventID:         identity.EventID,
		PreviousEventID: identity.PreviousEventID,
		Revision:        identity.Revision,
		Explanation:     payload.Explanation,
		Plan:            payload.Plan,
	}
}

// parseCodexPlanToolCall extracts only the literal argument of Codex's
// update_plan call. It never evaluates the surrounding JavaScript.
func parseCodexPlanToolCall(name string, input json.RawMessage) (codexPlanPayload, error) {
	if len(input) == 0 || len(input) > codexPlanMaxInputBytes {
		return codexPlanPayload{}, fmt.Errorf("codex plan input size is invalid")
	}

	var source string
	if err := json.Unmarshal(input, &source); err != nil {
		if name != "update_plan" {
			return codexPlanPayload{}, fmt.Errorf("codex plan wrapper input is not a string")
		}
		source = string(input)
	}
	if len(source) > codexPlanMaxInputBytes {
		return codexPlanPayload{}, fmt.Errorf("codex plan source is too large")
	}

	var literal string
	switch name {
	case "update_plan":
		literal = strings.TrimSpace(source)
	case "exec":
		var err error
		literal, err = extractCodexUpdatePlanLiteral(source)
		if err != nil {
			return codexPlanPayload{}, err
		}
	default:
		return codexPlanPayload{}, fmt.Errorf("unsupported codex plan tool %q", name)
	}

	parser := codexPlanLiteralParser{source: literal}
	value, err := parser.parseValue()
	if err != nil {
		return codexPlanPayload{}, err
	}
	parser.skipSpace()
	if parser.pos != len(parser.source) {
		return codexPlanPayload{}, fmt.Errorf("unexpected token after codex plan literal")
	}
	object, ok := value.(map[string]any)
	if !ok {
		return codexPlanPayload{}, fmt.Errorf("codex plan argument is not an object")
	}
	return validateCodexPlanObject(object)
}

func extractCodexUpdatePlanLiteral(source string) (string, error) {
	const target = "tools.update_plan"
	positions := findCodexPlanCalls(source, target)
	if len(positions) != 1 {
		return "", fmt.Errorf("expected exactly one tools.update_plan call")
	}
	pos := positions[0] + len(target)
	for pos < len(source) && isCodexPlanSpace(source[pos]) {
		pos++
	}
	if pos >= len(source) || source[pos] != '(' {
		return "", fmt.Errorf("tools.update_plan is not called with a literal")
	}
	start := pos + 1
	parser := codexPlanLiteralParser{source: source, pos: start}
	if _, err := parser.parseValue(); err != nil {
		return "", err
	}
	end := parser.pos
	parser.skipSpace()
	if parser.pos >= len(source) || source[parser.pos] != ')' {
		return "", fmt.Errorf("tools.update_plan call is not closed")
	}
	return source[start:end], nil
}

// findCodexPlanCalls ignores strings and comments in the surrounding wrapper,
// so a diagnostic string containing "tools.update_plan" cannot create a match.
func findCodexPlanCalls(source, target string) []int {
	var positions []int
	for i := 0; i < len(source); {
		switch source[i] {
		case '\'', '"', '`':
			i = skipCodexPlanQuoted(source, i)
		case '/':
			if i+1 < len(source) && source[i+1] == '/' {
				i += 2
				for i < len(source) && source[i] != '\n' {
					i++
				}
			} else if i+1 < len(source) && source[i+1] == '*' {
				i += 2
				for i+1 < len(source) && !(source[i] == '*' && source[i+1] == '/') {
					i++
				}
				if i+1 < len(source) {
					i += 2
				}
			} else {
				i++
			}
		default:
			if strings.HasPrefix(source[i:], target) &&
				(i == 0 || !isCodexPlanIdentifierByte(source[i-1])) &&
				(i+len(target) == len(source) || !isCodexPlanIdentifierByte(source[i+len(target)])) {
				positions = append(positions, i)
				i += len(target)
			} else {
				i++
			}
		}
	}
	return positions
}

func skipCodexPlanQuoted(source string, start int) int {
	quote := source[start]
	for i := start + 1; i < len(source); i++ {
		if source[i] == '\\' {
			i++
			continue
		}
		if source[i] == quote {
			return i + 1
		}
	}
	return len(source)
}

func validateCodexPlanObject(object map[string]any) (codexPlanPayload, error) {
	for key := range object {
		if key != "explanation" && key != "plan" {
			return codexPlanPayload{}, fmt.Errorf("unknown codex plan key %q", key)
		}
	}
	explanation := ""
	if raw, exists := object["explanation"]; exists {
		var ok bool
		explanation, ok = raw.(string)
		if !ok || len(explanation) > codexPlanMaxExplanationBytes {
			return codexPlanPayload{}, fmt.Errorf("codex plan explanation is invalid")
		}
		explanation = strings.TrimSpace(explanation)
	}
	rawPlan, ok := object["plan"].([]any)
	if !ok || len(rawPlan) == 0 || len(rawPlan) > codexPlanMaxItems {
		return codexPlanPayload{}, fmt.Errorf("codex plan item count is invalid")
	}
	plan := make([]protocol.PlanItem, 0, len(rawPlan))
	for _, rawItem := range rawPlan {
		item, ok := rawItem.(map[string]any)
		if !ok {
			return codexPlanPayload{}, fmt.Errorf("codex plan item is not an object")
		}
		for key := range item {
			if key != "step" && key != "status" {
				return codexPlanPayload{}, fmt.Errorf("unknown codex plan item key %q", key)
			}
		}
		step, stepOK := item["step"].(string)
		status, statusOK := item["status"].(string)
		step = strings.TrimSpace(step)
		if !stepOK || len(step) > codexPlanMaxStepBytes || !statusOK || !protocol.ValidPlanStatus(status) {
			return codexPlanPayload{}, fmt.Errorf("codex plan item is invalid")
		}
		if step == "" {
			continue
		}
		plan = append(plan, protocol.PlanItem{Step: step, Status: status})
	}
	if len(plan) == 0 {
		return codexPlanPayload{}, fmt.Errorf("codex plan has no visible items")
	}
	return codexPlanPayload{Explanation: explanation, Plan: plan}, nil
}

type codexPlanLiteralParser struct {
	source string
	pos    int
}

func (p *codexPlanLiteralParser) parseValue() (any, error) {
	p.skipSpace()
	if p.pos >= len(p.source) {
		return nil, fmt.Errorf("unexpected end of codex plan literal")
	}
	switch p.source[p.pos] {
	case '{':
		return p.parseObject()
	case '[':
		return p.parseArray()
	case '\'', '"':
		return p.parseString()
	default:
		return nil, fmt.Errorf("dynamic codex plan expression is not allowed")
	}
}

func (p *codexPlanLiteralParser) parseObject() (map[string]any, error) {
	p.pos++
	object := make(map[string]any)
	for {
		p.skipSpace()
		if p.pos >= len(p.source) {
			return nil, fmt.Errorf("unterminated codex plan object")
		}
		if p.source[p.pos] == '}' {
			p.pos++
			return object, nil
		}
		key, err := p.parseKey()
		if err != nil {
			return nil, err
		}
		if _, exists := object[key]; exists {
			return nil, fmt.Errorf("duplicate codex plan key %q", key)
		}
		p.skipSpace()
		if p.pos >= len(p.source) || p.source[p.pos] != ':' {
			return nil, fmt.Errorf("missing colon after codex plan key")
		}
		p.pos++
		value, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		object[key] = value
		p.skipSpace()
		if p.pos < len(p.source) && p.source[p.pos] == ',' {
			p.pos++
			p.skipSpace()
			if p.pos < len(p.source) && p.source[p.pos] == '}' {
				p.pos++
				return object, nil
			}
			continue
		}
		if p.pos < len(p.source) && p.source[p.pos] == '}' {
			p.pos++
			return object, nil
		}
		return nil, fmt.Errorf("expected comma or object end in codex plan")
	}
}

func (p *codexPlanLiteralParser) parseArray() ([]any, error) {
	p.pos++
	var values []any
	for {
		p.skipSpace()
		if p.pos >= len(p.source) {
			return nil, fmt.Errorf("unterminated codex plan array")
		}
		if p.source[p.pos] == ']' {
			p.pos++
			return values, nil
		}
		value, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		values = append(values, value)
		p.skipSpace()
		if p.pos < len(p.source) && p.source[p.pos] == ',' {
			p.pos++
			p.skipSpace()
			if p.pos < len(p.source) && p.source[p.pos] == ']' {
				p.pos++
				return values, nil
			}
			continue
		}
		if p.pos < len(p.source) && p.source[p.pos] == ']' {
			p.pos++
			return values, nil
		}
		return nil, fmt.Errorf("expected comma or array end in codex plan")
	}
}

func (p *codexPlanLiteralParser) parseKey() (string, error) {
	p.skipSpace()
	if p.pos >= len(p.source) {
		return "", fmt.Errorf("missing codex plan key")
	}
	if p.source[p.pos] == '\'' || p.source[p.pos] == '"' {
		return p.parseString()
	}
	start := p.pos
	for p.pos < len(p.source) && isCodexPlanIdentifierByte(p.source[p.pos]) {
		p.pos++
	}
	if start == p.pos {
		return "", fmt.Errorf("invalid codex plan key")
	}
	return p.source[start:p.pos], nil
}

func (p *codexPlanLiteralParser) parseString() (string, error) {
	quote := p.source[p.pos]
	p.pos++
	var out strings.Builder
	for p.pos < len(p.source) {
		ch := p.source[p.pos]
		p.pos++
		if ch == quote {
			return out.String(), nil
		}
		if ch != '\\' {
			out.WriteByte(ch)
			continue
		}
		if p.pos >= len(p.source) {
			return "", fmt.Errorf("unterminated codex plan escape")
		}
		escape := p.source[p.pos]
		p.pos++
		switch escape {
		case '\\', '\'', '"', '/':
			out.WriteByte(escape)
		case 'b':
			out.WriteByte('\b')
		case 'f':
			out.WriteByte('\f')
		case 'n':
			out.WriteByte('\n')
		case 'r':
			out.WriteByte('\r')
		case 't':
			out.WriteByte('\t')
		case 'u':
			r, err := p.parseUnicodeEscape()
			if err != nil {
				return "", err
			}
			out.WriteRune(r)
		default:
			return "", fmt.Errorf("unsupported codex plan string escape")
		}
	}
	return "", fmt.Errorf("unterminated codex plan string")
}

func (p *codexPlanLiteralParser) parseUnicodeEscape() (rune, error) {
	first, err := p.parseHexRune()
	if err != nil {
		return 0, err
	}
	if utf16.IsSurrogate(first) {
		if p.pos+2 > len(p.source) || p.source[p.pos:p.pos+2] != `\u` {
			return 0, fmt.Errorf("incomplete codex plan surrogate pair")
		}
		p.pos += 2
		second, err := p.parseHexRune()
		if err != nil {
			return 0, err
		}
		decoded := utf16.DecodeRune(first, second)
		if decoded == utf8.RuneError {
			return 0, fmt.Errorf("invalid codex plan surrogate pair")
		}
		return decoded, nil
	}
	return first, nil
}

func (p *codexPlanLiteralParser) parseHexRune() (rune, error) {
	if p.pos+4 > len(p.source) {
		return 0, fmt.Errorf("short codex plan unicode escape")
	}
	value, err := strconv.ParseUint(p.source[p.pos:p.pos+4], 16, 16)
	if err != nil {
		return 0, fmt.Errorf("invalid codex plan unicode escape")
	}
	p.pos += 4
	return rune(value), nil
}

func (p *codexPlanLiteralParser) skipSpace() {
	for p.pos < len(p.source) && isCodexPlanSpace(p.source[p.pos]) {
		p.pos++
	}
}

func isCodexPlanSpace(ch byte) bool {
	return ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t'
}

func isCodexPlanIdentifierByte(ch byte) bool {
	return ch == '_' || ch == '$' || ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9'
}
