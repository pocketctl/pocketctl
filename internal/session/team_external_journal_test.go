package session

import (
	"context"
	"errors"
	"sync"
	"testing"
)

func TestExternalJournalRestartAndFrozenIntent(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	r, _ := externalRequestFixture()
	j, err := OpenExternalJournal(root, r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	if err = j.SaveIntent(ctx, r); err != nil {
		t.Fatal(err)
	}
	if err = j.Close(); err != nil {
		t.Fatal(err)
	}
	j, err = OpenExternalJournal(root, r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	saved, receipt, err := j.Load(ctx, r.Identity.CallID)
	if err != nil || receipt != nil || string(saved.Input) != string(r.Input) {
		t.Fatal("lost intent", err)
	}
	if err = j.SaveIntent(ctx, r); err != nil {
		t.Fatal(err)
	}
	limit := int64(10)
	changed := r
	changed.MaxCostMicros = &limit
	if err = j.SaveIntent(ctx, changed); !errors.Is(err, ErrExternalConflict) {
		t.Fatal("changed cost accepted", err)
	}
	next := ExternalExecutionReceipt{Identity: r.Identity, InputDigest: r.InputDigest, RemoteTaskID: "remote", Sequence: 1, State: ExternalRunning}
	if _, err = j.RecordReceipt(ctx, next); err != nil {
		t.Fatal(err)
	}
	if err = j.Close(); err != nil {
		t.Fatal(err)
	}
	j, err = OpenExternalJournal(root, r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	_, receipt, err = j.Load(ctx, r.Identity.CallID)
	if err != nil || receipt == nil || receipt.RemoteTaskID != "remote" {
		t.Fatal("lost mapping", err)
	}
	next.State = ExternalSucceeded
	next.Sequence = 2
	if _, err = j.RecordReceipt(ctx, next); err != nil {
		t.Fatal(err)
	}
	if _, err = j.RecordReceipt(ctx, next); err != nil {
		t.Fatal("duplicate receipt", err)
	}
	next.Sequence = 1
	next.State = ExternalRunning
	result, err := j.RecordReceipt(ctx, next)
	if err != nil || result.State != ExternalSucceeded {
		t.Fatal("stale receipt", err)
	}
}
func TestExternalJournalScopeUniqueRequestsAndRemoteTasks(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	r, _ := externalRequestFixture()
	j, err := OpenExternalJournal(root, r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	other, err := OpenExternalJournal(root, "another-installation")
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if err = j.SaveIntent(ctx, r); err != nil {
		t.Fatal(err)
	}
	if _, _, err = other.Load(ctx, r.Identity.CallID); !errors.Is(err, ErrExternalMissing) {
		t.Fatal("scope leaked", err)
	}
	if err = other.SaveIntent(ctx, r); !errors.Is(err, ErrExternalIdentity) {
		t.Fatal("wrong identity saved", err)
	}
	second := r
	second.Identity.CallID = "second"
	if err = j.SaveIntent(ctx, second); !errors.Is(err, ErrExternalConflict) {
		t.Fatal("request reused", err)
	}
	second.Identity.RequestID = "request-2"
	if err = j.SaveIntent(ctx, second); err != nil {
		t.Fatal(err)
	}
	next := ExternalExecutionReceipt{Identity: r.Identity, InputDigest: r.InputDigest, RemoteTaskID: "remote", Sequence: 1, State: ExternalRunning}
	if _, err = j.RecordReceipt(ctx, next); err != nil {
		t.Fatal(err)
	}
	next.Identity = second.Identity
	if _, err = j.RecordReceipt(ctx, next); err == nil {
		t.Fatal("remote task mapped to two calls")
	}
	_, receipt, err := j.Load(ctx, second.Identity.CallID)
	if err != nil || receipt != nil {
		t.Fatal("failed write changed mapping", err)
	}
}
func TestExternalJournalConcurrentHandlesAndCorruption(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	r, _ := externalRequestFixture()
	first, err := OpenExternalJournal(root, r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := OpenExternalJournal(root, r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if err = first.SaveIntent(ctx, r); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i, j := range []*ExternalJournal{first, second} {
		wg.Add(1)
		go func(n int, j *ExternalJournal) {
			defer wg.Done()
			id := "remote-a"
			if n == 1 {
				id = "remote-b"
			}
			_, e := j.RecordReceipt(ctx, ExternalExecutionReceipt{Identity: r.Identity, InputDigest: r.InputDigest, RemoteTaskID: id, Sequence: 1, State: ExternalRunning})
			results <- e
		}(i, j)
	}
	wg.Wait()
	close(results)
	success := 0
	for e := range results {
		if e == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatalf("remote mappings committed: %d", success)
	}
	if _, err = first.db.ExecContext(ctx, `UPDATE external_executions SET request=? WHERE call_id=?`, []byte(`{}`), r.Identity.CallID); err != nil {
		t.Fatal(err)
	}
	if _, _, err = second.Load(ctx, r.Identity.CallID); !errors.Is(err, ErrExternalCorrupt) {
		t.Fatal("corruption accepted", err)
	}
}
