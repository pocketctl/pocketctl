package teamdelivery

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

type workerFixture struct {
	*publicationFixture
	page     JobPage
	cursors  []string
	statuses []ExportDiagnostic
}

func (f *workerFixture) ReportStatus(_ context.Context, _ protocol.TeamDeliveryJob, status ExportDiagnostic) error {
	f.statuses = append(f.statuses, status)
	return nil
}

type blockingWorkerAPI struct {
	*publicationFixture
	started chan struct{}
}

func (a *blockingWorkerAPI) Jobs(ctx context.Context, _, _ string) (JobPage, error) {
	close(a.started)
	<-ctx.Done()
	return JobPage{}, ctx.Err()
}

func TestWorkerRunStopsOnCancellation(t *testing.T) {
	api := &blockingWorkerAPI{newPublicationFixture(), make(chan struct{})}
	worker, err := NewWorker(api, t.TempDir(), "relay", "daemon-1", func(protocol.TeamDeliveryJob) (string, error) { return "", fmt.Errorf("unused") }, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { worker.Run(ctx); close(done) }()
	select {
	case <-api.started:
	case <-time.After(time.Second):
		t.Fatal("worker did not poll")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("worker ignored cancellation")
	}
}

func (f *workerFixture) Jobs(_ context.Context, _ string, cursor string) (JobPage, error) {
	f.cursors = append(f.cursors, cursor)
	return f.page, nil
}

func TestWorkerPublishesThenReclaimsOnlyConfirmedBytes(t *testing.T) {
	ctx := context.Background()
	root := fixtureWorkspace(t)
	job := fixtureJob()
	api := &workerFixture{publicationFixture: newPublicationFixture(), page: JobPage{OwnerUserID: 1, Jobs: []protocol.TeamDeliveryJob{job}}}
	api.dropPublish = true
	var codes []string
	worker, err := NewWorker(api, t.TempDir(), "relay", "daemon-1", func(protocol.TeamDeliveryJob) (string, error) { return root, nil }, func(_ string, code string) { codes = append(codes, code) })
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	if err := worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := worker.journal.Load(ctx, job.CallID); err != nil {
		t.Fatal("unconfirmed bytes discarded", err)
	}
	// Relay stops returning the job once publication commits, even if its HTTP
	// response was lost. Receipt reconciliation must work on an empty job page.
	api.page.Jobs = []protocol.TeamDeliveryJob{}
	api.receiptError = &HTTPError{503, "database_unavailable"}
	if err := worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := worker.journal.Load(ctx, job.CallID); err != nil {
		t.Fatal("failed read authorized cleanup", err)
	}
	api.receiptError = nil
	if err := worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := worker.journal.Load(ctx, job.CallID); !errors.Is(err, ErrSnapshotMissing) {
		t.Fatalf("confirmed bytes retained: %v", err)
	}
	snapshot, err := Collect(root, job)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := worker.journal.Save(ctx, snapshot); !errors.Is(err, ErrPublicationRetired) {
		t.Fatalf("retired call recaptured: %v", err)
	}
	if api.prepareEffects != 1 || api.publishEffects != 1 {
		t.Fatal("reconcile caused a second publication")
	}
	if len(codes) < 2 {
		t.Fatal("missing recovery diagnostics")
	}
}

func TestWorkerBadManifestDoesNotStarveNextJobOrPage(t *testing.T) {
	ctx := context.Background()
	root := fixtureWorkspace(t)
	bad, good := fixtureJob(), fixtureJob()
	good.CallID = "call-2"
	good.Authorization.CallID = good.CallID
	if err := os.Rename(filepath.Join(root, protocol.TeamDeliveryDirectory(bad.CallID)), filepath.Join(root, protocol.TeamDeliveryDirectory(good.CallID))); err != nil {
		t.Fatal(err)
	}
	next := "call-2"
	api := &workerFixture{publicationFixture: newPublicationFixture(), page: JobPage{OwnerUserID: 1, Jobs: []protocol.TeamDeliveryJob{bad, good}, NextCursor: &next}}
	worker, err := NewWorker(api, t.TempDir(), "relay", "daemon-1", func(protocol.TeamDeliveryJob) (string, error) { return root, nil }, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	if err := worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if api.publishEffects != 1 {
		t.Fatal("missing manifest prevented later job")
	}
	if len(api.statuses) != 1 || api.statuses[0].Phase != "waiting_for_files" || api.statuses[0].ErrorCode != "manifest_unavailable" {
		t.Fatalf("missing durable diagnostic: %+v", api.statuses)
	}
	api.page = JobPage{OwnerUserID: 1, Jobs: []protocol.TeamDeliveryJob{}}
	if err := worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if len(api.cursors) != 2 || api.cursors[1] != next || worker.cursor != "" {
		t.Fatalf("pagination failed: %v", api.cursors)
	}
}

func TestWorkerRechecksPrivateBindingBeforeResuming(t *testing.T) {
	ctx := context.Background()
	root := fixtureWorkspace(t)
	job := fixtureJob()
	api := &workerFixture{publicationFixture: newPublicationFixture(), page: JobPage{OwnerUserID: 1, Jobs: []protocol.TeamDeliveryJob{job}}}
	api.failUpload = true
	authorized := true
	worker, err := NewWorker(api, t.TempDir(), "relay", "daemon-1", func(protocol.TeamDeliveryJob) (string, error) {
		if !authorized {
			return "", fmt.Errorf("collaboration_binding_mismatch")
		}
		return root, nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	if err := worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	authorized = false
	if err := worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if api.uploadCalls != 1 || api.publishCalls != 0 {
		t.Fatal("private binding revocation ignored on retry")
	}
}

func TestWorkerChangesOwnerNamespaceAndResetsPagination(t *testing.T) {
	ctx := context.Background()
	next := "old-owner-cursor"
	api := &workerFixture{publicationFixture: newPublicationFixture(), page: JobPage{OwnerUserID: 1, Jobs: []protocol.TeamDeliveryJob{}, NextCursor: &next}}
	worker, err := NewWorker(api, t.TempDir(), "relay", "daemon-1", func(protocol.TeamDeliveryJob) (string, error) { return "", fmt.Errorf("unused") }, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	if err := worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	oldJournal := worker.journal
	api.page = JobPage{OwnerUserID: 2, Jobs: []protocol.TeamDeliveryJob{}}
	if err := worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if worker.journal == oldJournal || worker.owner != 2 || worker.cursor != "" {
		t.Fatal("identity namespace not reset")
	}
	if err := worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if api.cursors[2] != "" {
		t.Fatal("new identity skipped first page")
	}
}
