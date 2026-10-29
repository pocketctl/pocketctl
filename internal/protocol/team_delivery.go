package protocol

import (
	"crypto/sha256"
	"fmt"
	"regexp"
)

const CapabilityTeamDeliveryV1 = "team_task_delivery_v1"
const CapabilityTeamStepsV1 = "team_task_steps_v1"

// TeamDeliveryBinding is a Relay-authored capability binding, never inferred
// from natural-language context or an Agent-generated submission manifest.
type TeamDeliveryBinding struct {
	TaskID       string `json:"task_id"`
	SpecRevision int64  `json:"spec_revision"`
	AttemptID    string `json:"attempt_id,omitempty"`
}

var teamDeliveryAttemptID = regexp.MustCompile(`^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$`)

// Empty identifies the legacy Task scope. Step identities are canonical UUIDs;
// they are Relay authority, never extracted from Agent-produced manifests.
func ValidTeamDeliveryAttemptID(id string) bool {
	return id == "" || teamDeliveryAttemptID.MatchString(id)
}

func TeamDeliveryDirectory(callID string) string {
	return fmt.Sprintf(".pocketctl-deliveries/%x", sha256.Sum256([]byte(callID)))
}

type TeamDeliveryArtifact struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	MIMEType string `json:"mime_type"`
	ByteSize int    `json:"byte_size"`
	SHA256   string `json:"sha256"`
	Required bool   `json:"required"`
}

type TeamDeliveryEvidence struct {
	CheckID      string  `json:"check_id"`
	ArtifactID   string  `json:"artifact_id"`
	Result       string  `json:"result"`
	SourceKind   string  `json:"source_kind"`
	CodeRevision *string `json:"code_revision"`
}

// TeamDeliveryJob is returned only for a completed Call owned by this daemon.
// Native execution state remains Relay authority; publication is a separate step.
type TeamDeliveryJob struct {
	ExportRevision     int64                      `json:"export_revision"`
	CallID             string                     `json:"call_id"`
	TaskID             string                     `json:"task_id"`
	AttemptID          string                     `json:"attempt_id,omitempty"`
	SpecRevision       int64                      `json:"spec_revision"`
	Revision           int64                      `json:"revision"`
	NativeSessionID    string                     `json:"native_session_id"`
	Provider           string                     `json:"provider"`
	LatestSubmissionID *string                    `json:"latest_submission_id"`
	DeliveryRole       string                     `json:"delivery_role"`
	Authorization      CollaborationAuthorization `json:"authorization"`
}

type TeamDeliverySubmission struct {
	RequestID        string                 `json:"request_id"`
	ExpectedRevision int64                  `json:"expected_revision"`
	SpecRevision     int64                  `json:"spec_revision"`
	SourceCallID     string                 `json:"source_call_id"`
	Summary          string                 `json:"summary"`
	CodeRevision     *string                `json:"code_revision"`
	PublishScope     string                 `json:"publish_scope"`
	ContributionIDs  []string               `json:"contribution_ids"`
	Artifacts        []TeamDeliveryArtifact `json:"artifacts"`
	Evidence         []TeamDeliveryEvidence `json:"evidence"`
}
