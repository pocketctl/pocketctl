package teamdelivery

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

const testSubmissionID = "12345678-1234-4234-8234-123456789abc"

type publicationFixture struct {
	receipts                                                                map[string]*OperationReceipt
	head                                                                    DeliveryHead
	prepareCalls, publishCalls, uploadCalls, prepareEffects, publishEffects int
	prepareKeys                                                             []string
	publishKeys                                                             []string
	busyPrepare, busyPublish                                                bool
	uploaded                                                                []byte
	dropPrepare, dropPublish, failPrepareBefore, failUpload                 bool
	receiptError                                                            error
	advanceOnUpload                                                         bool
}

func (f *publicationFixture) ReportStatus(context.Context, protocol.TeamDeliveryJob, ExportDiagnostic) error {
	return nil
}

func newPublicationFixture() *publicationFixture {
	f := &publicationFixture{receipts: map[string]*OperationReceipt{}, head: DeliveryHead{Revision: 2, TaskState: "in_progress", WritesEnabled: true}}
	f.head.Spec.Revision = 1
	return f
}

func (f *publicationFixture) Receipt(_ context.Context, _, key string) (*OperationReceipt, error) {
	if f.receiptError != nil {
		return nil, f.receiptError
	}
	return f.receipts[key], nil
}
func (f *publicationFixture) Prepare(_ context.Context, _ string, input protocol.TeamDeliverySubmission) (OperationResult, error) {
	f.prepareCalls++
	f.prepareKeys = append(f.prepareKeys, input.RequestID)
	if f.busyPrepare {
		f.busyPrepare = false
		return OperationResult{}, &HTTPError{503, "source_busy"}
	}
	if f.failPrepareBefore {
		f.failPrepareBefore = false
		return OperationResult{}, fmt.Errorf("network unavailable")
	}
	if input.ExpectedRevision != f.head.Revision {
		return OperationResult{}, &HTTPError{409, "revision_conflict"}
	}
	if receipt := f.receipts[input.RequestID]; receipt != nil {
		return receipt.Response, nil
	}
	f.prepareEffects++
	result := OperationResult{SubmissionID: testSubmissionID, Revision: f.head.Revision, State: "preparing"}
	f.receipts[input.RequestID] = &OperationReceipt{Operation: "prepare_submission", Response: result}
	if f.dropPrepare {
		f.dropPrepare = false
		return OperationResult{}, fmt.Errorf("response lost after commit")
	}
	return result, nil
}
func (f *publicationFixture) Upload(_ context.Context, _, _ string, _ protocol.TeamDeliveryArtifact, data []byte) error {
	f.uploadCalls++
	if f.failUpload {
		f.failUpload = false
		return fmt.Errorf("upload interrupted")
	}
	f.uploaded = append([]byte(nil), data...)
	if f.advanceOnUpload {
		f.head.Revision++
		f.advanceOnUpload = false
	}
	return nil
}
func (f *publicationFixture) Publish(_ context.Context, _, submissionID string, input Mutation) (OperationResult, error) {
	f.publishCalls++
	f.publishKeys = append(f.publishKeys, input.RequestID)
	if f.busyPublish {
		f.busyPublish = false
		return OperationResult{}, &HTTPError{503, "source_busy"}
	}
	if input.ExpectedRevision != f.head.Revision {
		return OperationResult{}, &HTTPError{409, "revision_conflict"}
	}
	if receipt := f.receipts[input.RequestID]; receipt != nil {
		return receipt.Response, nil
	}
	f.publishEffects++
	f.head.Revision++
	result := OperationResult{SubmissionID: submissionID, Revision: f.head.Revision, State: "published", Version: 1}
	f.receipts[input.RequestID] = &OperationReceipt{Operation: "publish:" + submissionID, Response: result}
	if f.dropPublish {
		f.dropPublish = false
		return OperationResult{}, fmt.Errorf("response lost after commit")
	}
	return result, nil
}
func (f *publicationFixture) Head(context.Context, string) (DeliveryHead, error) { return f.head, nil }

func publisherFixture(t *testing.T) (*Publisher, *Snapshot, *publicationFixture) {
	t.Helper()
	snapshot, err := Collect(fixtureWorkspace(t), fixtureJob())
	if err != nil {
		t.Fatal(err)
	}
	journal, err := OpenJournal(t.TempDir(), "relay|daemon|owner")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = journal.Close() })
	if _, err := journal.Save(context.Background(), snapshot); err != nil {
		t.Fatal(err)
	}
	api := newPublicationFixture()
	return &Publisher{Journal: journal, API: api}, snapshot, api
}

func TestPublisherLostPrepareAndPublishResponsesSurviveRestart(t *testing.T) {
	ctx := context.Background()
	workspace, private := fixtureWorkspace(t), t.TempDir()
	snapshot, err := Collect(workspace, fixtureJob())
	if err != nil {
		t.Fatal(err)
	}
	api := newPublicationFixture()
	api.dropPrepare, api.dropPublish = true, true
	for attempt := 0; attempt < 3; attempt++ {
		journal, err := OpenJournal(private, "relay|daemon|owner")
		if err != nil {
			t.Fatal(err)
		}
		if attempt == 0 {
			if _, err = journal.Save(ctx, snapshot); err != nil {
				t.Fatal(err)
			}
		}
		publisher := &Publisher{Journal: journal, API: api}
		result, err := publisher.Publish(ctx, snapshot.Job.CallID)
		if attempt < 2 && err == nil {
			t.Fatal("lost write response reported as success")
		}
		if attempt == 2 && (err != nil || result.State != "published") {
			t.Fatalf("receipt recovery failed: %+v %v", result, err)
		}
		if err := journal.Close(); err != nil {
			t.Fatal(err)
		}
		// A retry has no reason to consult these now modified source bytes.
		if err := os.WriteFile(filepath.Join(workspace, protocol.TeamDeliveryDirectory("call-1"), "report.pdf"), []byte("changed"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if api.prepareEffects != 1 || api.publishEffects != 1 || api.prepareCalls != 1 || api.publishCalls != 1 || api.uploadCalls != 1 {
		t.Fatalf("duplicate work after lost response: %+v", api)
	}
	if !bytes.Equal(api.uploaded, snapshot.Files["report"]) {
		t.Fatal("retried upload changed bytes")
	}
}

func TestPublisherUnknownOutcomeDoesNotRebaseUntilDefinitiveConflict(t *testing.T) {
	publisher, snapshot, api := publisherFixture(t)
	ctx := context.Background()
	api.failPrepareBefore = true
	if _, err := publisher.Publish(ctx, snapshot.Job.CallID); err == nil {
		t.Fatal("missing network error")
	}
	api.head.Revision = 3
	if _, err := publisher.Publish(ctx, snapshot.Job.CallID); !revisionConflict(err) {
		t.Fatalf("expected original request CAS rejection: %v", err)
	}
	if len(api.prepareKeys) != 2 || api.prepareKeys[0] != api.prepareKeys[1] {
		t.Fatal("unknown request identity changed")
	}
	if _, err := publisher.Publish(ctx, snapshot.Job.CallID); err != errRevisionRetry {
		t.Fatalf("rebase not persisted: %v", err)
	}
	if len(api.prepareKeys) != 2 {
		t.Fatal("rebase attempted network write before durable state")
	}
	if result, err := publisher.Publish(ctx, snapshot.Job.CallID); err != nil || result.State != "published" {
		t.Fatalf("rebased publication failed: %+v %v", result, err)
	}
	if api.prepareKeys[2] == api.prepareKeys[0] || api.prepareEffects != 1 || api.publishEffects != 1 {
		t.Fatal("CAS recovery duplicated effects or reused key")
	}
}

func TestPublisherInterruptedUploadResumesSamePreparedSubmission(t *testing.T) {
	publisher, snapshot, api := publisherFixture(t)
	api.failUpload = true
	if _, err := publisher.Publish(context.Background(), snapshot.Job.CallID); err == nil {
		t.Fatal("missing upload failure")
	}
	if _, err := publisher.Publish(context.Background(), snapshot.Job.CallID); err != nil {
		t.Fatal(err)
	}
	if api.prepareEffects != 1 || api.prepareCalls != 1 || api.publishEffects != 1 || api.uploadCalls != 2 {
		t.Fatal("interrupted upload created a new submission")
	}
}

func TestPublisherRebasesPublishAfterConcurrentContribution(t *testing.T) {
	publisher, snapshot, api := publisherFixture(t)
	api.advanceOnUpload = true
	ctx := context.Background()
	if _, err := publisher.Publish(ctx, snapshot.Job.CallID); !revisionConflict(err) {
		t.Fatalf("expected publish conflict: %v", err)
	}
	if _, err := publisher.Publish(ctx, snapshot.Job.CallID); err != errRevisionRetry {
		t.Fatalf("expected durable rebase: %v", err)
	}
	if _, err := publisher.Publish(ctx, snapshot.Job.CallID); err != nil {
		t.Fatal(err)
	}
	if api.prepareEffects != 1 || api.prepareCalls != 1 || api.publishEffects != 1 || api.publishCalls != 2 {
		t.Fatal("concurrent contribution duplicated delivery")
	}
}

func TestPublicationProgressRejectsStaleWriter(t *testing.T) {
	publisher, snapshot, _ := publisherFixture(t)
	ctx := context.Background()
	first, err := publisher.Journal.publication(ctx, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	stale := first
	first.SubmissionID = testSubmissionID
	if err := publisher.Journal.savePublication(ctx, snapshot.Job.CallID, &first); err != nil {
		t.Fatal(err)
	}
	stale.PrepareRejected = true
	if err := publisher.Journal.savePublication(ctx, snapshot.Job.CallID, &stale); err != errPublicationChanged {
		t.Fatalf("stale worker overwrote progress: %v", err)
	}
	current, err := publisher.Journal.publication(ctx, snapshot)
	if err != nil || current.SubmissionID != testSubmissionID || current.PrepareRejected {
		t.Fatalf("prepared identity lost: %+v %v", current, err)
	}
}

func TestPublisherNeverReplacesNewerPrimaryOrSpec(t *testing.T) {
	for _, change := range []string{"primary", "spec", "permission", "terminal"} {
		t.Run(change, func(t *testing.T) {
			publisher, snapshot, api := publisherFixture(t)
			api.head.Revision = 3
			if _, err := publisher.Publish(context.Background(), snapshot.Job.CallID); !revisionConflict(err) {
				t.Fatal(err)
			}
			switch change {
			case "primary":
				id := testSubmissionID
				api.head.LatestSubmissionID = &id
			case "spec":
				api.head.Spec.Revision++
			case "permission":
				api.head.WritesEnabled = false
			case "terminal":
				api.head.TaskState = "completed"
			}
			if _, err := publisher.Publish(context.Background(), snapshot.Job.CallID); err == nil || err.Error() != "delivery_source_superseded" {
				t.Fatalf("unsafe rebase allowed: %v", err)
			}
			if api.prepareCalls != 1 || api.publishCalls != 0 {
				t.Fatal("superseded source performed another write")
			}
		})
	}
}

func TestPublisherReceiptFailureAndWrongReceiptPreventWrites(t *testing.T) {
	publisher, snapshot, api := publisherFixture(t)
	api.receiptError = &HTTPError{503, "database_unavailable"}
	if _, err := publisher.Publish(context.Background(), snapshot.Job.CallID); err == nil {
		t.Fatal("receipt error ignored")
	}
	if api.prepareCalls != 0 {
		t.Fatal("wrote without successful receipt lookup")
	}
	api.receiptError = nil
	api.receipts[snapshot.Submission.RequestID+"-2"] = &OperationReceipt{Operation: "another_operation", Response: OperationResult{SubmissionID: testSubmissionID, State: "preparing", Revision: 2}}
	if _, err := publisher.Publish(context.Background(), snapshot.Job.CallID); err == nil {
		t.Fatal("wrong receipt accepted")
	}
	if api.prepareCalls != 0 || api.uploadCalls != 0 {
		t.Fatal("wrong receipt triggered write")
	}
}

func TestPublisherSourceBusyRetriesOriginalIntentWithoutRebase(t *testing.T) {
	for _, phase := range []string{"prepare", "publish"} {
		t.Run(phase, func(t *testing.T) {
			publisher, snapshot, api := publisherFixture(t)
			api.busyPrepare, api.busyPublish = phase == "prepare", phase == "publish"
			ctx := context.Background()
			if _, err := publisher.Publish(ctx, snapshot.Job.CallID); err == nil || revisionConflict(err) {
				t.Fatalf("source contention must remain retryable without CAS rejection: %v", err)
			}
			state, err := publisher.Journal.publication(ctx, snapshot)
			if err != nil || state.PrepareRejected || state.PublishRejected || state.Result != nil {
				t.Fatalf("source contention changed the original intent: %+v %v", state, err)
			}
			// A recreated publisher recovers the persisted journal, with no head
			// advance or fresh native execution needed to release contention.
			recovered := &Publisher{Journal: publisher.Journal, API: api}
			result, err := recovered.Publish(ctx, snapshot.Job.CallID)
			if err != nil || result.State != "published" {
				t.Fatalf("original publication could not resume: %+v %v", result, err)
			}
			keys := api.prepareKeys
			if phase == "publish" {
				keys = api.publishKeys
			}
			if len(keys) != 2 || keys[0] != keys[1] || api.prepareEffects != 1 || api.publishEffects != 1 {
				t.Fatalf("retry replaced intent or duplicated effects: keys=%v prepare=%d publish=%d", keys, api.prepareEffects, api.publishEffects)
			}
		})
	}
}
