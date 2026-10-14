package approval

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"time"
)

type toolCallKey struct{ sessionID, toolUseID string }

type toolCallDecision struct {
	fingerprint [32]byte
	done        chan struct{}
	response    hookResponse // published by closing done
	expires     time.Time
}

// Completed decisions live briefly so hooks starting just after a decision
// receive it too. Never key on tool input alone: repeated commands are valid
// distinct operations. Old hooks without an invocation ID remain independent.
func (s *Server) joinToolCall(hr hookRequest) (*toolCallDecision, bool, bool) {
	if hr.ToolUseID == "" {
		return nil, true, false
	}
	var input any
	if len(hr.Input) > 0 {
		decoder := json.NewDecoder(bytes.NewReader(hr.Input))
		decoder.UseNumber() // distinct large integer arguments must stay distinct
		if decoder.Decode(&input) != nil {
			return nil, false, true
		}
	}
	b, _ := json.Marshal(struct {
		Tool, Cwd, Mode string
		Input           any
	}{hr.Tool, hr.Cwd, hr.PermMode, input})
	fingerprint := sha256.Sum256(b)
	key := toolCallKey{hr.SessionID, hr.ToolUseID}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for k, c := range s.calls {
		if !c.expires.IsZero() && !now.Before(c.expires) {
			delete(s.calls, k)
		}
	}
	if c := s.calls[key]; c != nil {
		return c, false, c.fingerprint != fingerprint
	}
	// Refuse overload rather than evicting a live authorization decision.
	if len(s.calls) >= 10000 {
		return nil, false, true
	}
	c := &toolCallDecision{fingerprint: fingerprint, done: make(chan struct{})}
	s.calls[key] = c
	return c, true, false
}

func (s *Server) completeToolCall(c *toolCallDecision, response hookResponse) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c.response = response
	c.expires = time.Now().Add(time.Minute)
	close(c.done)
}
