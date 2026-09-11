package protocol

// DirectoryResult is an ephemeral host query, never a session event.
type DirectoryResult struct {
	Path       string           `json:"path"`
	Parent     string           `json:"parent"`
	Roots      []string         `json:"roots"`
	Home       string           `json:"home"`
	Entries    []DirectoryEntry `json:"entries"`
	NextCursor string           `json:"next_cursor,omitempty"`
	CanBrowse  bool             `json:"can_browse"`
	CanSelect  bool             `json:"can_select"`
	Reason     string           `json:"reason,omitempty"`
	Fallback   bool             `json:"fallback,omitempty"`
}
type DirectoryEntry struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	CanBrowse bool   `json:"can_browse"`
	CanSelect bool   `json:"can_select"`
	Reason    string `json:"reason,omitempty"`
}
