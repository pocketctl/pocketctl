package quotareset

import (
	"context"
	"errors"
	"testing"
)

func TestJournalPersistsOutcomesAndRejectsConflicts(t *testing.T) {
	root := t.TempDir()
	s := New(root)
	calls := 0
	action := func() (string, error) { calls++; return "reset", nil }
	for i := 0; i < 2; i++ {
		r, err := s.Do(context.Background(), "scope", "operation-00000001", "WEEK", false, action)
		if err != nil || r.Outcome != "reset" {
			t.Fatalf("%+v %v", r, err)
		}
		s = New(root)
	}
	if calls != 1 {
		t.Fatal("replayed completed redemption")
	}
	if _, err := s.Do(context.Background(), "scope", "operation-00000001", "FIVE_HOUR", false, action); err == nil {
		t.Fatal("accepted changed request")
	}
}
func TestUnknownBlocksNewOperationAcrossRestart(t *testing.T) {
	root := t.TempDir()
	s := New(root)
	calls := 0
	action := func() (string, error) { calls++; return "", errors.New("secret token") }
	r, err := s.Do(context.Background(), "scope", "operation-00000001", "WEEK", false, action)
	if err != nil || r.Outcome != "unknown" {
		t.Fatalf("%+v %v", r, err)
	}
	s = New(root)
	r, err = s.Do(context.Background(), "scope", "operation-00000002", "WEEK", false, action)
	if err != nil || r.Outcome != "unknown" || calls != 1 {
		t.Fatal("unknown operation spent another card")
	}
	r, _ = s.Do(context.Background(), "scope", "operation-00000001", "WEEK", false, action)
	if calls != 1 || r.Outcome != "unknown" {
		t.Fatal("unverified provider replayed")
	}
}
func TestCodexUnknownRetriesOnlyOriginalKey(t *testing.T) {
	s := New(t.TempDir())
	calls := 0
	action := func() (string, error) {
		calls++
		if calls == 1 {
			return "", errors.New("timeout")
		}
		return "alreadyRedeemed", nil
	}
	s.Do(context.Background(), "scope", "operation-00000001", "codex", true, action)
	r, err := s.Do(context.Background(), "scope", "operation-00000001", "codex", true, action)
	if err != nil || r.Outcome != "alreadyRedeemed" || calls != 2 {
		t.Fatalf("%+v %v", r, err)
	}
}
func TestCancelledOperationNeverCallsProvider(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	called := false
	s := New(t.TempDir())
	_, e := s.Do(ctx, "scope", "operation-00000001", "codex", true, func() (string, error) { called = true; return "reset", nil })
	if e == nil || called {
		t.Fatal("cancelled operation reached provider")
	}
}
