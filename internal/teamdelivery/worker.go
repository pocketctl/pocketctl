package teamdelivery

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

type WorkerAPI interface {
	PublicationAPI
	ReportStatus(context.Context, protocol.TeamDeliveryJob, ExportDiagnostic) error
	Jobs(context.Context, string, string) (JobPage, error)
}

type Worker struct {
	mu                    sync.Mutex
	api                   WorkerAPI
	root, scope, daemonID string
	resolve               func(protocol.TeamDeliveryJob) (string, error)
	report                func(string, string)
	cursor, reclaimCursor string
	owner                 int
	journal               *Journal
}

func NewWorker(api WorkerAPI, root, relayScope, daemonID string, resolve func(protocol.TeamDeliveryJob) (string, error), report func(string, string)) (*Worker, error) {
	if api == nil || resolve == nil || relayScope == "" || daemonID == "" || !filepath.IsAbs(root) {
		return nil, fmt.Errorf("delivery_worker_configuration_invalid")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("delivery_journal_directory_invalid")
	}
	if err := os.Chmod(root, 0700); err != nil {
		return nil, err
	}
	// Verify private durable storage before advertising the capability.
	probe, err := OpenJournal(root, relayScope+"|"+daemonID+"|storage-probe")
	if err != nil {
		return nil, err
	}
	if err = probe.Close(); err != nil {
		return nil, err
	}
	return &Worker{api: api, root: root, scope: relayScope, daemonID: daemonID, resolve: resolve, report: report}, nil
}

// DiagnosticCode intentionally excludes HTTP bodies, local paths and tokens.
func DiagnosticCode(err error) string {
	if err == nil {
		return "published"
	}
	var h *HTTPError
	if errors.As(err, &h) {
		return h.Code
	}
	code := strings.SplitN(err.Error(), ":", 2)[0]
	if artifactID.MatchString(code) {
		return code
	}
	return "delivery_retry_pending"
}

func (w *Worker) Run(ctx context.Context) {
	defer w.Close()
	delay := 5 * time.Second
	for {
		if err := w.Tick(ctx); err != nil {
			if ctx.Err() == nil && w.report != nil {
				w.report("", DiagnosticCode(err))
			}
			delay = min(60*time.Second, delay*2)
		} else {
			delay = 5 * time.Second
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (w *Worker) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.journal != nil {
		err := w.journal.Close()
		w.journal = nil
		return err
	}
	return nil
}

// One page per tick keeps polling bounded. Failures on one Call never prevent
// other Calls or later pages from being processed; no execution API is used.
func (w *Worker) Tick(ctx context.Context) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	page, err := w.api.Jobs(ctx, w.daemonID, w.cursor)
	if err != nil {
		return err
	}
	if page.OwnerUserID < 1 || len(page.Jobs) > 100 || (page.NextCursor != nil && *page.NextCursor <= w.cursor) {
		return fmt.Errorf("delivery_jobs_invalid")
	}
	if w.owner != page.OwnerUserID || w.journal == nil {
		previousOwner := w.owner
		if w.journal != nil {
			_ = w.journal.Close()
		}
		w.journal = nil
		w.journal, err = OpenJournal(w.root, w.scope+"|"+w.daemonID+"|"+strconv.Itoa(page.OwnerUserID))
		if err != nil {
			return err
		}
		w.owner = page.OwnerUserID
		w.cursor, w.reclaimCursor = "", ""
		if previousOwner != 0 && previousOwner != w.owner {
			return nil
		}
	}
	// Receipt-only reconciliation may fail during revocation. It must not block
	// independent authorized jobs, nor does an error authorize deleting bytes.
	cursor, reclaimErr := w.journal.ReconcilePublished(ctx, w.api, w.reclaimCursor)
	w.reclaimCursor = cursor
	if reclaimErr != nil && w.report != nil {
		w.report("", DiagnosticCode(reclaimErr))
	}
	for _, job := range page.Jobs {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if validateJob(job) != nil || job.Authorization.OwnerUserID != w.owner || job.Authorization.DaemonID != w.daemonID {
			return fmt.Errorf("delivery_jobs_invalid")
		}
		jobCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		err = w.process(jobCtx, job)
		cancel()
		if err != nil && ctx.Err() == nil && !errors.Is(err, ErrPublicationRetired) {
			statusCtx, statusCancel := context.WithTimeout(ctx, 5*time.Second)
			statusErr := w.api.ReportStatus(statusCtx, job, exportDiagnostic(job, err))
			statusCancel()
			if statusErr != nil && w.report != nil {
				w.report(job.CallID, DiagnosticCode(statusErr))
			}
		}
		if w.report != nil {
			w.report(job.CallID, DiagnosticCode(err))
		}
	}
	w.cursor = ""
	if page.NextCursor != nil {
		w.cursor = *page.NextCursor
	}
	return nil
}

func exportDiagnostic(job protocol.TeamDeliveryJob, err error) ExportDiagnostic {
	result := ExportDiagnostic{ExpectedRevision: job.ExportRevision, Phase: "publication_pending", ErrorCode: "retry_pending"}
	code := DiagnosticCode(err)
	var h *HTTPError
	if errors.As(err, &h) {
		switch {
		case h.Status == 401 || h.Status == 403 || h.Status == 404:
			result.Phase, result.ErrorCode = "blocked", "authorization_changed"
		case h.Code == "budget_exhausted":
			result.Phase, result.ErrorCode = "blocked", "quota_exceeded"
		case h.Status == 409:
			result.ErrorCode = "revision_conflict"
		case h.Status >= 500:
			result.ErrorCode = "transport_unavailable"
		}
		return result
	}
	switch {
	case code == "delivery_manifest_unavailable":
		result.Phase, result.ErrorCode = "waiting_for_files", "manifest_unavailable"
	case code == "delivery_artifact_too_large":
		result.Phase, result.ErrorCode = "blocked", "artifact_too_large"
	case code == "delivery_artifact_unavailable":
		result.Phase, result.ErrorCode = "waiting_for_files", "artifact_unavailable"
	case strings.Contains(code, "limit"):
		result.Phase, result.ErrorCode = "blocked", "quota_exceeded"
	case strings.Contains(code, "manifest") || strings.Contains(code, "artifact") || strings.Contains(code, "evidence") || strings.Contains(code, "contribution"):
		result.Phase, result.ErrorCode = "blocked", "manifest_invalid"
	case strings.Contains(code, "source") || strings.Contains(code, "binding") || strings.Contains(code, "authorization"):
		result.Phase, result.ErrorCode = "blocked", "source_changed"
	case strings.Contains(code, "transport") || strings.Contains(code, "response"):
		result.ErrorCode = "transport_unavailable"
	}
	return result
}

func (w *Worker) process(ctx context.Context, job protocol.TeamDeliveryJob) error {
	// Recheck private ownership on every retry, even when bytes already exist.
	workspace, err := w.resolve(job)
	if err != nil {
		return err
	}
	snapshot, err := w.journal.Load(ctx, job.CallID)
	if errors.Is(err, ErrSnapshotMissing) {
		retired, checkErr := w.journal.Retired(ctx, job.CallID)
		if checkErr != nil {
			return checkErr
		}
		if retired {
			return ErrPublicationRetired
		}
		snapshot, err = Collect(workspace, job)
		if err != nil {
			return err
		}
		snapshot, err = w.journal.Save(ctx, snapshot)
	}
	if err != nil {
		return err
	}
	// Head revisions can advance, but persisted source authority cannot change.
	if !sameJobSource(snapshot.Job, job) {
		return fmt.Errorf("delivery_snapshot_source_changed")
	}
	_, err = (&Publisher{Journal: w.journal, API: w.api}).Publish(ctx, job.CallID)
	return err
}

func sameJobSource(a, b protocol.TeamDeliveryJob) bool {
	return a.CallID == b.CallID && a.TaskID == b.TaskID && a.AttemptID == b.AttemptID && a.SpecRevision == b.SpecRevision && a.NativeSessionID == b.NativeSessionID &&
		a.Provider == b.Provider && a.DeliveryRole == b.DeliveryRole && reflect.DeepEqual(a.Authorization, b.Authorization)
}
