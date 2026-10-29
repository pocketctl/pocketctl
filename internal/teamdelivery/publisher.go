package teamdelivery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

var errPublicationChanged = errors.New("delivery_publication_changed_retry")
var errRevisionRetry = errors.New("delivery_revision_rebased_retry")

type publication struct {
	Version         int64            `json:"version"`
	PrepareRevision int64            `json:"prepare_revision"`
	PublishRevision int64            `json:"publish_revision"`
	PrepareRejected bool             `json:"prepare_rejected"`
	PublishRejected bool             `json:"publish_rejected"`
	SubmissionID    string           `json:"submission_id"`
	Result          *OperationResult `json:"result"`
}

func (j *Journal) publication(ctx context.Context, snapshot *Snapshot) (publication, error) {
	initial := publication{Version: 1, PrepareRevision: snapshot.Submission.ExpectedRevision, PublishRevision: snapshot.Submission.ExpectedRevision}
	payload, err := json.Marshal(initial)
	if err != nil {
		return publication{}, err
	}
	_, err = j.db.ExecContext(ctx, `INSERT OR IGNORE INTO delivery_publications(call_id,version,payload)
SELECT ?,1,? WHERE NOT EXISTS(SELECT 1 FROM delivery_retired WHERE call_id=?)`, snapshot.Job.CallID, payload, snapshot.Job.CallID)
	if err != nil {
		return publication{}, err
	}
	var version int64
	err = j.db.QueryRowContext(ctx, `SELECT version,payload FROM delivery_publications WHERE call_id=?`, snapshot.Job.CallID).Scan(&version, &payload)
	if err != nil {
		return publication{}, err
	}
	var state publication
	if err := decodeStrict(payload, &state); err != nil {
		return publication{}, err
	}
	if state.Version != version || version < 1 || state.PrepareRevision < 1 || state.PublishRevision < 1 ||
		(state.SubmissionID != "" && !contributionID.MatchString(state.SubmissionID)) ||
		(state.Result != nil && (!validResult(*state.Result) || state.Result.State != "published" || state.Result.SubmissionID != state.SubmissionID)) {
		return publication{}, fmt.Errorf("delivery_publication_corrupt")
	}
	return state, nil
}

func (j *Journal) savePublication(ctx context.Context, callID string, state *publication) error {
	prior := state.Version
	next := *state
	next.Version++
	payload, err := json.Marshal(next)
	if err != nil {
		return err
	}
	result, err := j.db.ExecContext(ctx, `UPDATE delivery_publications SET version=?,payload=? WHERE call_id=? AND version=?`, next.Version, payload, callID, prior)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return errPublicationChanged
	}
	*state = next
	return nil
}

type PublicationAPI interface {
	Receipt(context.Context, string, string) (*OperationReceipt, error)
	Prepare(context.Context, string, protocol.TeamDeliverySubmission) (OperationResult, error)
	Upload(context.Context, string, string, protocol.TeamDeliveryArtifact, []byte) error
	Publish(context.Context, string, string, Mutation) (OperationResult, error)
	Head(context.Context, string) (DeliveryHead, error)
}

type Publisher struct {
	Journal *Journal
	API     PublicationAPI
}

// Scope binding is explicit and immutable. An API without step support must
// fail closed instead of publishing through the legacy Task endpoint.
func publicationAPIForJob(api PublicationAPI, job protocol.TeamDeliveryJob) (PublicationAPI, error) {
	if job.AttemptID == "" {
		return api, nil
	}
	if !protocol.ValidTeamDeliveryAttemptID(job.AttemptID) {
		return nil, fmt.Errorf("delivery_attempt_invalid")
	}
	binder, ok := api.(interface {
		ForAttempt(string) (PublicationAPI, error)
	})
	if !ok {
		return nil, fmt.Errorf("delivery_attempt_unsupported")
	}
	return binder.ForAttempt(job.AttemptID)
}

// Publish never reads the Agent workspace. It resumes only a durable snapshot
// and queries each original receipt before any write retry. A new request ID is
// possible only after a definitive CAS rejection, persisted before rebasing.
func (p *Publisher) Publish(ctx context.Context, callID string) (OperationResult, error) {
	snapshot, err := p.Journal.Load(ctx, callID)
	if err != nil {
		return OperationResult{}, err
	}
	state, err := p.Journal.publication(ctx, snapshot)
	if err != nil {
		return OperationResult{}, err
	}
	if state.Result != nil {
		return *state.Result, nil
	}
	api, err := publicationAPIForJob(p.API, snapshot.Job)
	if err != nil {
		return OperationResult{}, err
	}
	taskID := snapshot.Job.TaskID
	if state.SubmissionID == "" {
		input := snapshot.Submission
		input.ExpectedRevision = state.PrepareRevision
		input.RequestID += "-" + strconv.FormatInt(state.PrepareRevision, 10)
		receipt, err := api.Receipt(ctx, taskID, input.RequestID)
		if err != nil {
			return OperationResult{}, err
		}
		var result OperationResult
		if receipt != nil {
			if receipt.Operation != "prepare_submission" || receipt.Response.State != "preparing" || !validResult(receipt.Response) {
				return OperationResult{}, fmt.Errorf("delivery_receipt_mismatch")
			}
			result = receipt.Response
		} else {
			if state.PrepareRejected {
				return OperationResult{}, p.rebase(ctx, api, snapshot, &state, false)
			}
			result, err = api.Prepare(ctx, taskID, input)
			if err != nil {
				if revisionConflict(err) {
					state.PrepareRejected = true
					if saveErr := p.Journal.savePublication(ctx, callID, &state); saveErr != nil {
						return OperationResult{}, saveErr
					}
				}
				return OperationResult{}, err
			}
		}
		if result.State != "preparing" || !validResult(result) {
			return OperationResult{}, fmt.Errorf("delivery_prepare_response_unknown")
		}
		state.SubmissionID = result.SubmissionID
		state.PublishRevision = result.Revision
		state.PrepareRejected = false
		if err := p.Journal.savePublication(ctx, callID, &state); err != nil {
			return OperationResult{}, err
		}
	}
	input := Mutation{RequestID: "daemon-publish-" + snapshot.Submission.RequestID[len("daemon-prepare-"):] + "-" + strconv.FormatInt(state.PublishRevision, 10), ExpectedRevision: state.PublishRevision}
	receipt, err := api.Receipt(ctx, taskID, input.RequestID)
	if err != nil {
		return OperationResult{}, err
	}
	var result OperationResult
	if receipt != nil {
		if receipt.Operation != "publish:"+state.SubmissionID || receipt.Response.SubmissionID != state.SubmissionID ||
			receipt.Response.State != "published" || !validResult(receipt.Response) {
			return OperationResult{}, fmt.Errorf("delivery_receipt_mismatch")
		}
		result = receipt.Response
	} else {
		if state.PublishRejected {
			return OperationResult{}, p.rebase(ctx, api, snapshot, &state, true)
		}
		for _, artifact := range snapshot.Submission.Artifacts {
			if err := api.Upload(ctx, taskID, state.SubmissionID, artifact, snapshot.Files[artifact.ID]); err != nil {
				return OperationResult{}, err
			}
		}
		result, err = api.Publish(ctx, taskID, state.SubmissionID, input)
		if err != nil {
			if revisionConflict(err) {
				state.PublishRejected = true
				if saveErr := p.Journal.savePublication(ctx, callID, &state); saveErr != nil {
					return OperationResult{}, saveErr
				}
			}
			return OperationResult{}, err
		}
	}
	if result.State != "published" || result.SubmissionID != state.SubmissionID || !validResult(result) {
		return OperationResult{}, fmt.Errorf("delivery_publish_response_unknown")
	}
	state.Result = &result
	if err := p.Journal.savePublication(ctx, callID, &state); err != nil {
		return OperationResult{}, err
	}
	return result, nil
}

func revisionConflict(err error) bool {
	var value *HTTPError
	return errors.As(err, &value) && value.Status == 409 && value.Code == "revision_conflict"
}

func (p *Publisher) rebase(ctx context.Context, api PublicationAPI, snapshot *Snapshot, state *publication, publishing bool) error {
	head, err := api.Head(ctx, snapshot.Job.TaskID)
	if err != nil {
		return err
	}
	// A competing contribution may advance the head without replacing the main
	// delivery. A late primary must never overwrite a newer primary implicitly.
	if !head.WritesEnabled || (head.TaskState != "open" && head.TaskState != "in_progress") || head.Spec.Revision != snapshot.Job.SpecRevision ||
		(snapshot.Job.DeliveryRole != "contribution" && !sameRevision(head.LatestSubmissionID, snapshot.Job.LatestSubmissionID)) {
		return fmt.Errorf("delivery_source_superseded")
	}
	previous := state.PrepareRevision
	if publishing {
		previous = state.PublishRevision
	}
	if head.Revision <= previous {
		return fmt.Errorf("delivery_revision_unresolved")
	}
	if publishing {
		state.PublishRevision, state.PublishRejected = head.Revision, false
	} else {
		state.PrepareRevision, state.PrepareRejected = head.Revision, false
	}
	if err := p.Journal.savePublication(ctx, snapshot.Job.CallID, state); err != nil {
		return err
	}
	return errRevisionRetry
}
