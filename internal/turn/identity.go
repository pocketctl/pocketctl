package turn

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Identity carries the available turn identity evidence for one start, in the
// frozen priority order of plan §3.4. It never receives content — only opaque
// identifiers — so derived IDs cannot leak prompts, paths or usernames.
type Identity struct {
	Agent string
	// SourceTurnID is the agent-native turn id (Codex app-server).
	SourceTurnID string
	// RequestID is the relay/client-supplied request id for controlled input.
	RequestID string
	// SourceMessageID is a stable source user-message identity (OpenCode
	// message id, ZCode message sequence/id, Claude JSONL record identity).
	SourceMessageID string
}

// SourceKind and SourceID report the highest-priority identity evidence
// available, following plan §3.4: native > request > source message.
func (id Identity) SourceKind() (kind, sourceID string) {
	switch {
	case id.SourceTurnID != "":
		return "native", id.SourceTurnID
	case id.RequestID != "":
		return "request", id.RequestID
	case id.SourceMessageID != "":
		return "source_message", id.SourceMessageID
	default:
		return "", ""
	}
}

// Origin returns the turn_origin wire value for this identity. When no anchor
// exists the turn stays unassigned (empty logical id) instead of being guessed
// into a group.
func (id Identity) Origin() string {
	switch kind, _ := id.SourceKind(); kind {
	case "native":
		return protocol.TurnOriginNative
	case "request":
		return protocol.TurnOriginRequest
	case "source_message":
		return protocol.TurnOriginSourceMessage
	default:
		return protocol.TurnOriginLegacyUnassigned
	}
}

// LogicalTurnID derives the namespaced deterministic logical turn id:
//
//	turn:v1:<agent>:<base64url(sha256(session_id|actor_id|source-kind|source-id))>
//
// The input is restricted to opaque identifiers joined with "|" so the hash is
// unambiguous and content-free. Returns "" when no anchor exists.
func LogicalTurnID(agent, sessionID, actorID, kind, sourceID string) string {
	if kind == "" || sourceID == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(strings.Join([]string{
		sessionID, actorID, kind, sourceID,
	}, "|")))
	return fmt.Sprintf("turn:v1:%s:%s", agent, base64.RawURLEncoding.EncodeToString(sum[:]))
}

// Resolve returns (logicalTurnID, origin) for the identity within the given
// actor scope.
func (id Identity) Resolve(sessionID, actorID string) (string, string) {
	kind, sourceID := id.SourceKind()
	return LogicalTurnID(id.Agent, sessionID, actorID, kind, sourceID), id.Origin()
}

// HashRequestID reduces a request id to a short content-free digest for the
// journal, which stores only a hash of the correlation id.
func HashRequestID(requestID string) string {
	if requestID == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(requestID))
	return hex.EncodeToString(sum[:8])
}
