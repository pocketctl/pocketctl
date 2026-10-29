package teamdelivery

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// An old snapshot or revoked read permission is not evidence that an earlier
// publish failed. Keep the original bytes and key until the exact receipt is
// readable, including across daemon restarts.
func TestReconcileRetainsUnconfirmedSnapshotsAcrossRestart(t *testing.T) {
	for _, outcome := range []string{"forbidden", "not_found", "unavailable", "absent", "wrong_operation", "wrong_submission", "preparing"} {
		t.Run(outcome, func(t *testing.T) {
			ctx := context.Background()
			root := t.TempDir()
			journal, err := OpenJournal(root, "relay|daemon|owner")
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = journal.Close() }()
			snapshot, err := Collect(fixtureWorkspace(t), fixtureJob())
			if err != nil {
				t.Fatal(err)
			}
			if _, err = journal.Save(ctx, snapshot); err != nil {
				t.Fatal(err)
			}
			api := newPublicationFixture()
			api.dropPublish = true
			publisher := &Publisher{Journal: journal, API: api}
			if _, err = publisher.Publish(ctx, snapshot.Job.CallID); err == nil {
				t.Fatal("expected lost response")
			}
			key := api.publishKeys[0]
			original := *api.receipts[key]
			changed := original
			switch outcome {
			case "forbidden":
				api.receiptError = &HTTPError{403, "membership_required"}
			case "not_found":
				api.receiptError = &HTTPError{404, "team_not_found"}
			case "unavailable":
				api.receiptError = &HTTPError{503, "database_unavailable"}
			case "absent":
				delete(api.receipts, key)
			case "wrong_operation":
				changed.Operation = "prepare_submission"
				api.receipts[key] = &changed
			case "wrong_submission":
				changed.Response.SubmissionID = "22345678-1234-4234-8234-123456789abc"
				api.receipts[key] = &changed
			case "preparing":
				changed.Response.State = "preparing"
				api.receipts[key] = &changed
			}
			if _, err = journal.db.Exec(`UPDATE delivery_snapshots SET created_at=0`); err != nil {
				t.Fatal(err)
			}
			if err = journal.Close(); err != nil {
				t.Fatal(err)
			}
			journal, err = OpenJournal(root, "relay|daemon|owner")
			if err != nil {
				t.Fatal(err)
			}
			for range 3 {
				_, _ = journal.ReconcilePublished(ctx, api, "")
				retained, err := journal.Load(ctx, snapshot.Job.CallID)
				if err != nil || !reflect.DeepEqual(retained, snapshot) {
					t.Fatalf("unknown snapshot changed: %v", err)
				}
				retired, err := journal.Retired(ctx, snapshot.Job.CallID)
				if err != nil || retired {
					t.Fatalf("unknown publication retired: %v", err)
				}
			}
			api.receiptError = nil
			api.receipts[key] = &original
			if _, err = journal.ReconcilePublished(ctx, api, ""); err != nil {
				t.Fatal(err)
			}
			if _, err = journal.Load(ctx, snapshot.Job.CallID); !errors.Is(err, ErrSnapshotMissing) {
				t.Fatalf("confirmed snapshot retained: %v", err)
			}
			if api.prepareCalls != 1 || api.uploadCalls != 1 || api.publishCalls != 1 {
				t.Fatal("receipt reconciliation performed a new write")
			}
		})
	}
}

type revokedReceiptFixture struct {
	*publicationFixture
	blockedKey string
}

func (f *revokedReceiptFixture) Receipt(ctx context.Context, task, key string) (*OperationReceipt, error) {
	if key == f.blockedKey {
		return nil, &HTTPError{404, "team_not_found"}
	}
	return f.publicationFixture.Receipt(ctx, task, key)
}

func TestReconcileRevokedSnapshotDoesNotStarveOtherReceipts(t *testing.T) {
	ctx := context.Background()
	journal, err := OpenJournal(t.TempDir(), "relay|daemon|owner")
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	combined := &revokedReceiptFixture{publicationFixture: newPublicationFixture()}
	for _, id := range []string{"call-1", "call-2"} {
		workspace := fixtureWorkspace(t)
		job := fixtureJob()
		if id != job.CallID {
			if err := os.Rename(filepath.Join(workspace, protocol.TeamDeliveryDirectory(job.CallID)), filepath.Join(workspace, protocol.TeamDeliveryDirectory(id))); err != nil {
				t.Fatal(err)
			}
			job.CallID, job.Authorization.CallID = id, id
		}
		snapshot, err := Collect(workspace, job)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = journal.Save(ctx, snapshot); err != nil {
			t.Fatal(err)
		}
		api := newPublicationFixture()
		api.dropPublish = true
		if _, err = (&Publisher{Journal: journal, API: api}).Publish(ctx, id); err == nil {
			t.Fatal("expected lost response")
		}
		key := api.publishKeys[0]
		combined.receipts[key] = api.receipts[key]
		if id == "call-1" {
			combined.blockedKey = key
		}
	}
	cursor, err := journal.ReconcilePublished(ctx, combined, "")
	if err == nil || cursor != "call-1" {
		t.Fatalf("revoked item did not advance cursor: %q %v", cursor, err)
	}
	if _, err = journal.ReconcilePublished(ctx, combined, cursor); err != nil {
		t.Fatal(err)
	}
	if _, err = journal.Load(ctx, "call-1"); err != nil {
		t.Fatal("revoked bytes lost", err)
	}
	if _, err = journal.Load(ctx, "call-2"); !errors.Is(err, ErrSnapshotMissing) {
		t.Fatal("authorized receipt starved", err)
	}
	if combined.prepareCalls+combined.uploadCalls+combined.publishCalls != 0 {
		t.Fatal("reconciliation wrote to Relay")
	}
}
