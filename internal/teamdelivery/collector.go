// Package teamdelivery captures explicit Team deliverables independently from
// native execution. It never infers completion or publication from chat text.
package teamdelivery

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/sessiondocument"
)

const (
	MaxArtifactBytes = 2 * 1024 * 1024
	MaxSnapshotBytes = 32 * 1024 * 1024
	MaxManifestBytes = 64 * 1024
)

var artifactID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`)
var contributionID = regexp.MustCompile(`(?i)^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$`)

type manifestArtifact struct {
	ID       string `json:"id"`
	Path     string `json:"path"`
	MIMEType string `json:"mime_type"`
	Required *bool  `json:"required"`
}

type manifest struct {
	SchemaVersion   int                             `json:"schema_version"`
	PublishScope    string                          `json:"publish_scope"`
	Summary         string                          `json:"summary"`
	CodeRevision    *string                         `json:"code_revision"`
	ContributionIDs []string                        `json:"contribution_ids"`
	Artifacts       []manifestArtifact              `json:"artifacts"`
	Evidence        []protocol.TeamDeliveryEvidence `json:"evidence"`
}

// Snapshot is persisted before any network write. Bytes, manifest, request ID,
// and the Relay source identity travel together through process restarts.
type Snapshot struct {
	Version    int                             `json:"version"`
	Job        protocol.TeamDeliveryJob        `json:"job"`
	Submission protocol.TeamDeliverySubmission `json:"submission"`
	Files      map[string][]byte               `json:"files"`
}

func textValid(value string, max int) bool {
	return utf8.ValidString(value) && strings.TrimSpace(value) != "" && len(value) <= max && !strings.ContainsRune(value, 0)
}

func decodeStrict(data []byte, value any) error {
	if !utf8.Valid(data) {
		return fmt.Errorf("delivery_manifest_invalid_utf8")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return fmt.Errorf("delivery_manifest_invalid: %w", err)
	}
	if decoder.Decode(new(any)) != io.EOF {
		return fmt.Errorf("delivery_manifest_trailing_content")
	}
	return nil
}

func validateJob(job protocol.TeamDeliveryJob) error {
	a := job.Authorization
	if !textValid(job.CallID, 128) || !textValid(job.TaskID, 128) || job.SpecRevision < 1 || job.Revision < 1 || job.ExportRevision < 0 ||
		!textValid(job.NativeSessionID, 256) || a.CallID != job.CallID || a.Delivery == nil ||
		(job.DeliveryRole != "primary" && job.DeliveryRole != "contribution") ||
		(job.LatestSubmissionID != nil && !contributionID.MatchString(*job.LatestSubmissionID)) ||
		a.Delivery.TaskID != job.TaskID || a.Delivery.SpecRevision != job.SpecRevision ||
		!protocol.ValidTeamDeliveryAttemptID(job.AttemptID) || a.Delivery.AttemptID != job.AttemptID ||
		a.ProtocolVersion != 1 || (a.Operation != "create" && a.Operation != "message") ||
		!textValid(a.BindingID, 128) || !textValid(a.TeamSessionID, 128) || !textValid(a.OfferID, 128) ||
		a.BindingRevision < 1 || a.OfferRevision < 1 || a.OwnerUserID < 1 || !textValid(a.DaemonID, 128) ||
		(job.Provider != "codex" && job.Provider != "claude-code" && job.Provider != "dsh" && job.Provider != "agentteams") {
		return fmt.Errorf("delivery_source_invalid")
	}
	return nil
}

// Collect requires a workspace authorized against the daemon's private native
// binding record. Use the workspace itself as the secure-open root, so even a
// symlink replacing the call-specific output directory cannot escape it.
func Collect(workspace string, job protocol.TeamDeliveryJob) (*Snapshot, error) {
	if err := validateJob(job); err != nil {
		return nil, err
	}
	directory := protocol.TeamDeliveryDirectory(job.CallID)
	manifestPath := directory + "/submission.json"
	raw, err := sessiondocument.ReadExplicitArtifact(workspace, manifestPath, MaxManifestBytes)
	if err != nil {
		return nil, fmt.Errorf("delivery_manifest_unavailable: %w", err)
	}
	var input manifest
	if err = decodeStrict(raw, &input); err != nil {
		return nil, err
	}
	if input.SchemaVersion != 1 || input.PublishScope != "team" || !textValid(input.Summary, 16000) ||
		(input.CodeRevision != nil && !textValid(*input.CodeRevision, 200)) ||
		len(input.Artifacts) < 1 || len(input.Artifacts) > 16 || len(input.Evidence) > 32 || len(input.ContributionIDs) > 32 {
		return nil, fmt.Errorf("delivery_manifest_invalid")
	}
	seenContributions := map[string]bool{}
	if job.AttemptID != "" && len(input.ContributionIDs) != 0 {
		return nil, fmt.Errorf("delivery_contribution_invalid")
	}
	for _, id := range input.ContributionIDs {
		if !contributionID.MatchString(id) || seenContributions[id] {
			return nil, fmt.Errorf("delivery_contribution_invalid")
		}
		seenContributions[id] = true
	}
	if input.ContributionIDs == nil {
		input.ContributionIDs = []string{}
	}
	if input.Evidence == nil {
		input.Evidence = []protocol.TeamDeliveryEvidence{}
	}
	digest := sha256.Sum256([]byte(job.CallID))
	result := &Snapshot{Version: 1, Job: job, Files: map[string][]byte{}, Submission: protocol.TeamDeliverySubmission{
		RequestID: "daemon-prepare-" + hex.EncodeToString(digest[:]), ExpectedRevision: job.Revision,
		SpecRevision: job.SpecRevision, SourceCallID: job.CallID, Summary: input.Summary, CodeRevision: input.CodeRevision,
		PublishScope: input.PublishScope, ContributionIDs: input.ContributionIDs, Evidence: input.Evidence,
		Artifacts: []protocol.TeamDeliveryArtifact{},
	}}
	seenPaths := map[string]bool{}
	for _, artifact := range input.Artifacts {
		if !artifactID.MatchString(artifact.ID) || artifact.Required == nil || result.Files[artifact.ID] != nil ||
			!textValid(artifact.Path, 1024) || path.IsAbs(artifact.Path) || path.Clean(artifact.Path) != artifact.Path ||
			artifact.Path == "." || artifact.Path == ".." || strings.HasPrefix(artifact.Path, "../") ||
			strings.ContainsAny(artifact.Path, "\\\r\n") || artifact.Path == "submission.json" || seenPaths[artifact.Path] {
			return nil, fmt.Errorf("delivery_artifact_path_invalid")
		}
		name := path.Base(artifact.Path)
		if !textValid(name, 240) {
			return nil, fmt.Errorf("delivery_artifact_name_invalid")
		}
		switch artifact.MIMEType {
		case "text/plain", "text/markdown", "text/html", "text/x-diff", "application/json", "application/pdf":
		default:
			return nil, fmt.Errorf("delivery_artifact_type_invalid")
		}
		data, err := sessiondocument.ReadExplicitArtifact(workspace, directory+"/"+artifact.Path, MaxArtifactBytes)
		if err != nil {
			if errors.Is(err, sessiondocument.ErrArtifactTooLarge) {
				return nil, fmt.Errorf("delivery_artifact_too_large: %w", err)
			}
			return nil, fmt.Errorf("delivery_artifact_unavailable: %w", err)
		}
		seenPaths[artifact.Path] = true
		hash := sha256.Sum256(data)
		result.Files[artifact.ID] = data
		result.Submission.Artifacts = append(result.Submission.Artifacts, protocol.TeamDeliveryArtifact{
			ID: artifact.ID, Name: name, MIMEType: artifact.MIMEType, ByteSize: len(data), SHA256: hex.EncodeToString(hash[:]), Required: *artifact.Required,
		})
	}
	seenChecks := map[string]bool{}
	for _, evidence := range input.Evidence {
		if !textValid(evidence.CheckID, 120) || seenChecks[evidence.CheckID] || result.Files[evidence.ArtifactID] == nil ||
			evidence.SourceKind != "agent_claim" || (evidence.Result != "passed" && evidence.Result != "failed" && evidence.Result != "unverified") ||
			!sameRevision(evidence.CodeRevision, input.CodeRevision) {
			return nil, fmt.Errorf("delivery_evidence_invalid")
		}
		seenChecks[evidence.CheckID] = true
	}
	// A manifest rewritten during collection is not a committed snapshot. File
	// hashes describe the actual bytes captured, never an Agent-supplied digest.
	final, err := sessiondocument.ReadExplicitArtifact(workspace, manifestPath, MaxManifestBytes)
	if err != nil || !bytes.Equal(raw, final) {
		return nil, fmt.Errorf("delivery_manifest_changed")
	}
	return result, nil
}

func sameRevision(a, b *string) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

func (s *Snapshot) validate() error {
	requestHash := sha256.Sum256([]byte(s.Job.CallID))
	if s.Version != 1 || validateJob(s.Job) != nil || s.Submission.SourceCallID != s.Job.CallID ||
		(s.Job.AttemptID != "" && len(s.Submission.ContributionIDs) != 0) ||
		s.Submission.RequestID != "daemon-prepare-"+hex.EncodeToString(requestHash[:]) ||
		s.Submission.SpecRevision != s.Job.SpecRevision || s.Submission.ExpectedRevision != s.Job.Revision ||
		s.Submission.PublishScope != "team" || len(s.Files) != len(s.Submission.Artifacts) || len(s.Files) < 1 || len(s.Files) > 16 {
		return fmt.Errorf("delivery_snapshot_invalid")
	}
	total := 0
	seen := map[string]bool{}
	for _, artifact := range s.Submission.Artifacts {
		data := s.Files[artifact.ID]
		hash := sha256.Sum256(data)
		if seen[artifact.ID] || len(data) < 1 || len(data) > MaxArtifactBytes || artifact.ByteSize != len(data) || artifact.SHA256 != hex.EncodeToString(hash[:]) {
			return fmt.Errorf("delivery_snapshot_integrity")
		}
		seen[artifact.ID] = true
		total += len(data)
	}
	if total > MaxSnapshotBytes {
		return fmt.Errorf("delivery_snapshot_limit")
	}
	return nil
}
