package teamdelivery

import (
	"context"
	"fmt"
	"strconv"
	"time"
)

// ReconcilePublished performs read-only receipt checks even for jobs no longer
// returned by Relay (a publish may have committed just before its response was
// lost). Only an exact authoritative receipt allows local byte reclamation.
func (j *Journal) ReconcilePublished(ctx context.Context, api PublicationAPI, after string) (string, error) {
	rows, err := j.db.QueryContext(ctx, `SELECT call_id FROM delivery_snapshots WHERE call_id>? ORDER BY call_id LIMIT 20`, after)
	if err != nil {
		return after, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		ids = append(ids, id)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return after, err
	}
	for _, id := range ids {
		// Advance past an unreadable item for this sweep. The next complete
		// sweep retries it; a revoked task cannot starve unrelated reclamation.
		after = id
		if len(ids) < 20 && id == ids[len(ids)-1] {
			after = ""
		}
		snapshot, err := j.Load(ctx, id)
		if err != nil {
			return after, err
		}
		state, err := j.publication(ctx, snapshot)
		if err != nil {
			return after, err
		}
		if state.SubmissionID == "" {
			continue
		}
		key := "daemon-publish-" + snapshot.Submission.RequestID[len("daemon-prepare-"):] + "-" + strconv.FormatInt(state.PublishRevision, 10)
		scoped, err := publicationAPIForJob(api, snapshot.Job)
		if err != nil {
			return after, err
		}
		receipt, err := scoped.Receipt(ctx, snapshot.Job.TaskID, key)
		if err != nil {
			return after, err
		}
		if receipt == nil {
			continue
		}
		if receipt.Operation != "publish:"+state.SubmissionID || receipt.Response.State != "published" ||
			receipt.Response.SubmissionID != state.SubmissionID || !validResult(receipt.Response) {
			return after, fmt.Errorf("delivery_receipt_mismatch")
		}
		tx, err := j.db.BeginTx(ctx, nil)
		if err != nil {
			return after, err
		}
		_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO delivery_retired(call_id,task_id,submission_id,request_id,confirmed_at) VALUES(?,?,?,?,?)`, id, snapshot.Job.TaskID, state.SubmissionID, key, time.Now().UnixMilli())
		if err == nil {
			_, err = tx.ExecContext(ctx, `DELETE FROM delivery_snapshots WHERE call_id=?`, id)
		}
		if err == nil {
			_, err = tx.ExecContext(ctx, `DELETE FROM delivery_publications WHERE call_id=?`, id)
		}
		if err != nil {
			_ = tx.Rollback()
			return after, err
		}
		if err = tx.Commit(); err != nil {
			return after, err
		}
	}
	if len(ids) == 20 {
		return ids[len(ids)-1], nil
	}
	return "", nil
}
