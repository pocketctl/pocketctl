package zcode

import (
	"encoding/json"
)

// types.go holds the strongly-typed ZCode JSON shapes (only whitelisted fields).
// The Store returns raw message/part data JSON; these types decode just the
// fields the mapper needs. Unknown fields are ignored (ZCode may add columns /
// JSON keys), so a schema addition never breaks decoding. The mapper NEVER
// receives a raw map[string]any — it always gets these decoded values.
//
// See design §6.1: "Do not unmarshal ZCode JSON into map[string]any and pass it
// through wholesale."

// ZcodeMessageData is the whitelisted projection of message.data JSON.
type ZcodeMessageData struct {
	Role       string          `json:"role"`       // "user" | "assistant" (others filtered)
	Synthetic  bool            `json:"synthetic"`  // synthetic=true → drop whole message
	System     json.RawMessage `json:"system"`     // non-null/non-empty → drop
	Hidden     bool            `json:"hidden"`     // hidden=true → drop
	Internal   bool            `json:"internal"`   // internal=true → drop
	Visibility string          `json:"visibility"` // must be user-visible ("" ok)
	Model      *ZcodeModelRef  `json:"model"`      // shape 2: model.providerID/modelID
	ProviderID string          `json:"providerID"` // shape 1: top-level providerID
	ModelID    string          `json:"modelID"`    // shape 1: top-level modelID
	Error      *ZcodeError     `json:"error"`      // assistant message error
	Parts      []ZcodePartData `json:"parts"`      // parts belonging to this message
	Finish     string          `json:"finish"`     // assistant finish signal: "" (null/user/running), "stop", "tool-calls", "completed"
	Agent      string          `json:"agent"`      // zcode agent variant (e.g. "zcode-agent", "zcode-explore")
}

// ZcodeModelRef is shape 2 of model: an object with providerID/modelID.
type ZcodeModelRef struct {
	ProviderID string `json:"providerID"`
	ModelID    string `json:"modelID"`
}

// ZcodeError is an assistant message error. Only a safe text field is surfaced;
// the raw error JSON is never uploaded.
type ZcodeError struct {
	Message string `json:"message"`
}

// ZcodePartData is the whitelisted projection of part.data JSON. Only the part
// types in the allowed set are mapped; step-start participates in status only.
type ZcodePartData struct {
	Type      string          `json:"type"`      // text|reasoning|tool|step-start|step-finish|file|...
	Text      string          `json:"text"`      // text/reasoning content
	Reasoning string          `json:"reasoning"` // reasoning content (alternate key)
	Tool      string          `json:"tool"`      // tool name (tool parts)
	CallID    string          `json:"callID"`    // tool call identity
	State     *ZcodeToolState `json:"state"`     // tool lifecycle state
	File      *ZcodeFile      `json:"file"`      // file part (basename + mime only)
	Usage     *ZcodeUsage     `json:"usage"`     // step-finish token usage
	// StepStart/StepFinish markers carry no user content.
	Step *ZcodeStep `json:"step"`
}

// ZcodeToolState is the whitelisted tool lifecycle state.
type ZcodeToolState struct {
	Status string          `json:"status"` // pending|running|completed|error
	Input  json.RawMessage `json:"input"`
	Output string          `json:"output"`
	Error  string          `json:"error"`
}

// ZcodeFile is the file part. Only basename + mime survive; URL/source/paths are
// cleared by the mapper (design §5.5).
type ZcodeFile struct {
	Filename string `json:"filename"`
	Mime     string `json:"mime"`
	URL      string `json:"url"`
	Source   string `json:"source"`
}

// ZcodeUsage is the token-usage object on step-finish (usage-only agent_text).
type ZcodeUsage struct {
	InputTokens     int64 `json:"input"`
	OutputTokens    int64 `json:"output"`
	ReasoningTokens int64 `json:"reasoning"`
	TotalTokens     int64 `json:"total"`
}

// ZcodeStep marks step-start/step-finish (no user content).
type ZcodeStep struct {
	Status string `json:"status"`
}

// DecodeMessageData decodes raw message.data JSON into the whitelisted shape.
// Returns ok=false if the JSON is unparseable (caller drops the row and counts
// it as a bad-JSON row for the >10% threshold).
func DecodeMessageData(raw string) (ZcodeMessageData, bool) {
	var m ZcodeMessageData
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return ZcodeMessageData{}, false
	}
	return m, true
}

// DecodePartData decodes raw part.data JSON into the whitelisted shape.
func DecodePartData(raw string) (ZcodePartData, bool) {
	var p ZcodePartData
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		return ZcodePartData{}, false
	}
	return p, true
}

// ResolveModel applies the model-resolution order (design §6.1):
//  1. message.data.providerID + message.data.modelID
//  2. message.data.model.providerID + message.data.model.modelID
//  3. only modelID
//  4. ""
func (m ZcodeMessageData) ResolveModel() string {
	if m.ProviderID != "" && m.ModelID != "" {
		return m.ProviderID + "/" + m.ModelID
	}
	if m.Model != nil && m.Model.ProviderID != "" && m.Model.ModelID != "" {
		return m.Model.ProviderID + "/" + m.Model.ModelID
	}
	if m.ModelID != "" {
		return m.ModelID
	}
	if m.Model != nil && m.Model.ModelID != "" {
		return m.Model.ModelID
	}
	return ""
}
