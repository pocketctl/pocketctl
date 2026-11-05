package protocol

// MemorySourceProvenance is producer metadata. It grants no permission and must
// never be populated from agent text or a model's interpretation of its source.
type MemorySourceProvenance struct {
	Version             int      `json:"version"`
	Producer            string   `json:"producer"`
	SessionID           string   `json:"session_id"`
	TurnID              string   `json:"turn_id"`
	EventID             string   `json:"event_id"`
	Sequence            string   `json:"sequence"`
	InvocationID        string   `json:"invocation_id"`
	ParentInvocationID  string   `json:"parent_invocation_id,omitempty"`
	SourceRole          string   `json:"source_role"`
	SkillState          string   `json:"skill_state"`
	SkillInvocationID   string   `json:"skill_invocation_id,omitempty"`
	LineageComplete     bool     `json:"lineage_complete"`
	DerivedFromEventIDs []string `json:"derived_from_event_ids"`
}

// MemoryNativeEvent is process-local evidence from a native decoder. It is
// deliberately not accepted from or serialized to the transport wire.
type MemoryNativeEvent struct {
	DirectRoot     bool
	CompleteCall   bool
	Ordinal        int
	Producer       string
	RecordID       string
	ParentRecordID string
	RootID         string
	OccurredAt     string
	UserRoot       bool
	Sidechain      bool
	Skill          bool
	UnknownChild   bool
}
