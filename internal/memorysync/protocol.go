// Package memorysync implements the explicit Phase 4 repository source sync
// (ADR-0006): it collects exactly one clean committed Git tree, applies the
// frozen hard-deny/ignore/secret/size/language rules, and uploads bounded
// content-addressed batches to the operator-owned Memory origin under a
// Relay-minted `memory.codegraph.write` grant. It never runs merely because a
// Session exists, never reads untracked or ignored files, and never follows
// symlinks.
package memorysync

// RepositoryRef is the installation-scoped repository identity derived from
// Git metadata. The local checkout path never appears here.
type RepositoryRef struct {
	RepositoryKey   string `json:"repository_key"`
	CanonicalRemote string `json:"canonical_remote,omitempty"`
}

// StartCodeSnapshotRequest is the frozen start body (plan §3.3). Strict
// server-side schemas reject unknown fields.
type StartCodeSnapshotRequest struct {
	Repository          RepositoryRef `json:"repository"`
	GitObjectFormat     string        `json:"git_object_format"`
	CommitSHA           string        `json:"commit_sha"`
	ManifestSHA256      string        `json:"manifest_sha256"`
	ExpectedFileCount   int           `json:"expected_file_count"`
	ExpectedByteCount   int64         `json:"expected_byte_count"`
	ParserMatrixVersion string        `json:"parser_matrix_version"`
	IdempotencyKey      string        `json:"idempotency_key"`
}

// CodeSnapshotFileEntry is one uploaded file: content-addressed by SHA-256
// (Git object ids are metadata only).
type CodeSnapshotFileEntry struct {
	Path          string `json:"path"`
	GitMode       string `json:"git_mode"`
	Language      string `json:"language"`
	Capability    string `json:"capability"`
	BlobSHA256    string `json:"blob_sha256"`
	ByteCount     int64  `json:"byte_count"`
	ContentBase64 string `json:"content_base64"`
}

// CodeSnapshotFileBatch is one bounded PUT body. A retry of the same
// (snapshot_id, batch_index) must be byte-identical.
type CodeSnapshotFileBatch struct {
	BatchIndex int                    `json:"batch_index"`
	Entries    []CodeSnapshotFileEntry `json:"entries"`
}

// FinalizeCodeSnapshotRequest closes the manifest after every batch landed.
type FinalizeCodeSnapshotRequest struct {
	ManifestSHA256    string `json:"manifest_sha256"`
	ExpectedFileCount int    `json:"expected_file_count"`
	ExpectedByteCount int64  `json:"expected_byte_count"`
	IdempotencyKey    string `json:"idempotency_key"`
}

// StartResult echoes the resolved opaque repository and snapshot ids.
type StartResult struct {
	SnapshotID   string `json:"snapshot_id"`
	RepositoryID string `json:"repository_id"`
}

// FinalizeResult reflects the post-finalization snapshot state.
type FinalizeResult struct {
	SnapshotID string `json:"snapshot_id"`
	State      string `json:"state"`
}

// Frozen upload limits (ADR-0006 §2). Tests may inject smaller bounds, the
// production collector always uses DefaultLimits.
const (
	ParserMatrixVersion = "phase4-v1"

	defaultMaxAcceptedFiles = 5000
	defaultMaxTotalBytes    = int64(64 << 20)
	defaultMaxFileBytes     = int64(256 << 10)

	// MaxRequestBytes bounds one HTTP request body (base64-inflated content).
	MaxRequestBytes = int64(1 << 20)
)

// Limits are the injectable source-selection bounds.
type Limits struct {
	MaxAcceptedFiles int
	MaxTotalBytes    int64
	MaxFileBytes     int64
}

// DefaultLimits returns the frozen production bounds.
func DefaultLimits() Limits {
	return Limits{
		MaxAcceptedFiles: defaultMaxAcceptedFiles,
		MaxTotalBytes:    defaultMaxTotalBytes,
		MaxFileBytes:     defaultMaxFileBytes,
	}
}
