package claudechannel

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

// IPC protocol constants.
const (
	// MaxPreviewRunes is the maximum number of runes retained from a tool
	// description / input preview before it is truncated for IPC and relay.
	// Larger payloads are cropped and marked. Design §Task 5: "preview 200
	// 字符".
	MaxPreviewRunes = 200

	// BootstrapTokenBytes is the size of a fresh capability token in raw
	// bytes (256 bits). It is hex-encoded on the wire (64 ASCII chars).
	BootstrapTokenBytes = 32

	// InstanceIDBytes is the size of a fresh instance id in raw bytes
	// (128 bits). Hex-encoded on the wire (32 ASCII chars).
	InstanceIDBytes = 16

	// PublicRequestIDBytes is the size of the public UUID-flavored request
	// id in raw bytes (128 bits). Hex-encoded on the wire.
	PublicRequestIDBytes = 16

	// DefaultBootstrapTTL is how long a bootstrap token remains valid for
	// the Channel process to register. After it expires the instance must
	// not be accepted. Design §Task 5: "bootstrap token 默认 60 秒内必须
	// register".
	DefaultBootstrapTTL = 60 * time.Second

	// DefaultClaimTimeout bounds Channel startup so a dead daemon cannot hold
	// Claude's MCP initialization (and therefore its native terminal) hostage.
	DefaultClaimTimeout = 200 * time.Millisecond

	// HeartbeatInterval is the persistent-channel heartbeat period.
	HeartbeatInterval = 15 * time.Second

	// ReconnectInterval is deliberately short and entirely off Claude's
	// terminal path. While disconnected, permission prompts remain native-only.
	ReconnectInterval = 250 * time.Millisecond
)

// Frame kinds. The IPC frame carries a single Envelope with a Kind.
const (
	KindBootstrapAcquire = "bootstrap.acquire"
	KindBootstrapBind    = "bootstrap.bind"
	KindChannelRegister  = "channel.register"
	KindChannelRequest   = "channel.request"
	KindChannelVerdict   = "channel.verdict"
	KindChannelClose     = "channel.close"
	KindPing             = "ping"
	KindPong             = "pong"
)

// Close reasons. These are the only values the daemon/Channel may emit on a
// channel.close frame.
const (
	CloseReasonDaemonShutdown    = "daemon_shutdown"
	CloseReasonChannelExit       = "channel_exit"
	CloseReasonInstanceUnknown   = "instance_unknown"
	CloseReasonTokenMismatch     = "token_mismatch"
	CloseReasonInstanceExpired   = "instance_expired"
	CloseReasonDuplicateRegister = "duplicate_register"
	CloseReasonServerError       = "server_error"
)

// Envelope is the single IPC frame shape. Every wire message is an Envelope
// with a Kind and a method-specific Payload (json.RawMessage so unknown
// fields are ignored).
type Envelope struct {
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// BootstrapAcquire is sent by the shim to obtain a fresh instance id +
// capability token + MCP config path before exec'ing real Claude.
type BootstrapAcquire struct {
	// ClaudeParentPID is the shim PID. syscall.Exec preserves that PID when
	// replacing the shim with real Claude, so channel.register must report the
	// same value from the Channel child's os.Getppid().
	ClaudeParentPID      int    `json:"claude_parent_pid,omitempty"`
	ProtocolVersion      string `json:"protocol_version,omitempty"`
	ProcessStartIdentity string `json:"process_start_identity,omitempty"`
}

// BootstrapBind moves a short-lived reservation from a launcher PID to the
// real Claude child PID. Unix exec preserves the launcher PID and does not use
// this frame; Windows sends it immediately after cmd.Start.
type BootstrapBind struct {
	InstanceID           string `json:"instance_id"`
	CapabilityToken      string `json:"capability_token"`
	ClaudeParentPID      int    `json:"claude_parent_pid"`
	ProcessStartIdentity string `json:"process_start_identity"`
}

// BootstrapAcquireResult is the daemon's reply.
type BootstrapAcquireResult struct {
	InstanceID      string    `json:"instance_id"`
	CapabilityToken string    `json:"capability_token"`
	MCPConfigPath   string    `json:"mcp_config_path"`
	ExpiresAt       time.Time `json:"expires_at"`
}

// ChannelRegister is sent by the Channel process once it has started. It
// binds the bootstrap token to the live Channel connection and reports the
// PID of the real Claude parent (so the daemon can correlate with the
// watcher-discovered session).
type ChannelRegister struct {
	InstanceID           string `json:"instance_id"`
	CapabilityToken      string `json:"capability_token"`
	ChannelPID           int    `json:"channel_pid"`
	ClaudeParentPID      int    `json:"claude_parent_pid"`
	ProtocolVersion      string `json:"protocol_version"`
	ProcessStartIdentity string `json:"process_start_identity"`
}

// ChannelRequest is sent by the Channel process to the daemon when Claude
// emits a permission request notification. ShortRequestID is Claude's
// 5-letter ID. Description / InputPreview are sanitized and length-capped.
type ChannelRequest struct {
	InstanceID     string `json:"instance_id"`
	ShortRequestID string `json:"short_request_id"`
	ToolName       string `json:"tool_name"`
	Description    string `json:"description"`
	InputPreview   string `json:"input_preview"`
}

// ChannelVerdict is sent by the daemon to the Channel process when Web/iOS
// (or the terminal-observed winner) emits a verdict. PublicRequestID is the
// daemon's UUID; ShortRequestID is Claude's 5-letter ID. Behavior is
// allow|deny.
type ChannelVerdict struct {
	PublicRequestID string `json:"public_request_id"`
	ShortRequestID  string `json:"short_request_id"`
	Behavior        string `json:"behavior"`
}

// ChannelClose carries a close reason. Either side may emit it; the daemon
// uses it to fail-closed pending requests on the Channel without sending a
// verdict.
type ChannelClose struct {
	Reason string `json:"reason"`
}

// PingPayload / PongPayload are liveness probes.
type PingPayload struct {
	At time.Time `json:"at"`
}

type PongPayload struct {
	At time.Time `json:"at"`
}

// --- helpers --------------------------------------------------------------

// NewCapabilityToken returns a fresh 256-bit hex-encoded token. The token is
// a capability: only the Channel process that received it at bootstrap may
// use it to register. It MUST NOT be logged.
func NewCapabilityToken() string {
	var raw [BootstrapTokenBytes]byte
	if _, err := rand.Read(raw[:]); err != nil {
		// rand.Read failing is catastrophic; do not silently weaken the token.
		panic("claudechannel: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(raw[:])
}

// NewInstanceID returns a fresh 128-bit hex-encoded instance id.
func NewInstanceID() string {
	var raw [InstanceIDBytes]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic("claudechannel: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(raw[:])
}

// NewPublicRequestID returns a canonical UUID surfaced to Web/iOS.
func NewPublicRequestID() string {
	return uuid.NewString()
}

// ConstantTimeTokenEqual reports whether a and b are equal in constant time.
// It returns 1 only when both are the same length AND bytes equal. Empty
// strings are never equal to anything (so an unset token can't match).
func ConstantTimeTokenEqual(a, b string) bool {
	if len(a) == 0 || len(b) == 0 || len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// SanitizePreview caps the preview to MaxPreviewRunes, strips control
// characters and zero-width / bidi overrides (design §Task 5: "UTF-8,
// control char、零宽/双向字符清洗"). It also validates UTF-8 validity.
func SanitizePreview(s string) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "")
	}
	// Strip control chars except tab/newline (kept for readability), and the
	// zero-width / bidi overrides Claude Code 2.1.211 hardened against.
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if isControlOrSpoofingRune(r) {
			continue
		}
		b.WriteRune(r)
	}
	clean := b.String()
	// Cap to MaxPreviewRunes. Crop with an ellipsis marker so the receiver
	// can tell the preview was truncated.
	if utf8.RuneCountInString(clean) > MaxPreviewRunes {
		runes := []rune(clean)
		clean = string(runes[:MaxPreviewRunes]) + "…"
	}
	return clean
}

// isControlOrSpoofingRune reports whether r is a control character, a
// zero-width joiner/no-break space, or a bidi-override rune used in
// homoglyph / direction-spoofing attacks.
func isControlOrSpoofingRune(r rune) bool {
	switch r {
	case '\u200B', // zero width space
		'\u200C',                                         // zero width non-joiner
		'\u200D',                                         // zero width joiner
		'\u200E',                                         // left-to-right mark
		'\u200F',                                         // right-to-left mark
		'\u202A', '\u202B', '\u202C', '\u202D', '\u202E', // bidi overrides
		'\u2066', '\u2067', '\u2068', '\u2069', // bidi isolates
		'\uFEFF': // zero width no-break space / BOM
		return true
	}
	// Strip control chars except tab/newline/carriage-return.
	if r < 0x20 && r != '\t' && r != '\n' && r != '\r' {
		return true
	}
	if r >= 0x7F && r <= 0x9F {
		return true
	}
	return false
}

// EncodeEnvelope marshals an Envelope to a newline-terminated JSON frame
// suitable for the length-prefix-or-newline wire. The result is capped at
// MaxJSONRPCFrame; larger frames are rejected to bound daemon memory.
func EncodeEnvelope(kind string, payload any) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("claudechannel: marshal %s payload: %w", kind, err)
	}
	env := Envelope{Kind: kind, Payload: body}
	frame, err := json.Marshal(env)
	if err != nil {
		return nil, err
	}
	if len(frame) > MaxJSONRPCFrame {
		return nil, fmt.Errorf("claudechannel: %s frame exceeds %d bytes", kind, MaxJSONRPCFrame)
	}
	return append(frame, '\n'), nil
}

// writeFull keeps a logical frame on one stream and rejects writers that
// report success without making progress. Callers must not retry the frame on
// a different connection after any error because the peer may have received a
// prefix already.
func writeFull(w io.Writer, frame []byte) error {
	for len(frame) > 0 {
		n, err := w.Write(frame)
		if n < 0 || n > len(frame) {
			return io.ErrShortWrite
		}
		frame = frame[n:]
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

// DecodeEnvelope reads a single newline-terminated frame from buf and
// returns the decoded Envelope plus the number of bytes consumed. It
// rejects oversized frames and malformed JSON.
func DecodeEnvelope(buf []byte) (Envelope, int, error) {
	newline := bytes.IndexByte(buf, '\n')
	if newline < 0 {
		return Envelope{}, 0, errIncompleteFrame
	}
	if newline > MaxJSONRPCFrame {
		return Envelope{}, 0, errOversizedFrame
	}
	var env Envelope
	if err := json.Unmarshal(buf[:newline], &env); err != nil {
		return Envelope{}, newline + 1, fmt.Errorf("claudechannel: decode: %w", err)
	}
	return env, newline + 1, nil
}

// DecodePayload unmarshals an Envelope.Payload into target. Callers pass a
// pointer to the method-specific payload struct.
func DecodePayload(env Envelope, target any) error {
	if len(env.Payload) == 0 {
		return nil
	}
	return json.Unmarshal(env.Payload, target)
}

// errIncompleteFrame is returned by DecodeEnvelope when buf does not yet
// contain a full newline-terminated frame.
var errIncompleteFrame = fmt.Errorf("claudechannel: incomplete frame")

// errOversizedFrame is returned when a single frame would exceed the cap.
var errOversizedFrame = fmt.Errorf("claudechannel: oversized frame")
