package session

import (
	"context"
	"errors"
	"sync"
	"testing"
)

type externalStub struct {
	mu                           sync.Mutex
	submits, lookups, cancels    int
	receipt                      ExternalExecutionReceipt
	loseResponse                 bool
	submitEntered, submitRelease chan struct{}
	cancelErr                    error
	lookupErr                    error
	unsafeRetry                  bool
	lastRequest                  ExternalExecutionRequest
}

func (s *externalStub) Capabilities(context.Context) (ExternalCapabilities, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, caps := externalRequestFixture()
	caps.AutomaticRetry = s.unsafeRetry
	return caps, nil
}
func (s *externalStub) Submit(_ context.Context, r ExternalExecutionRequest) (ExternalExecutionReceipt, error) {
	s.mu.Lock()
	s.submits++
	s.lastRequest = cloneExternalRequest(r)
	s.receipt = ExternalExecutionReceipt{Identity: r.Identity, InputDigest: r.InputDigest, RemoteTaskID: "remote", Sequence: 1, State: ExternalRunning}
	receipt := s.receipt
	lose := s.loseResponse
	s.mu.Unlock()
	if s.submitEntered != nil {
		close(s.submitEntered)
		<-s.submitRelease
	}
	if lose {
		return ExternalExecutionReceipt{}, errors.New("response lost")
	}
	return receipt, nil
}
func (s *externalStub) Lookup(_ context.Context, id ExternalExecutionIdentity) (ExternalExecutionReceipt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lookups++
	if s.lookupErr != nil {
		return ExternalExecutionReceipt{}, s.lookupErr
	}
	if s.receipt.Identity != id {
		return ExternalExecutionReceipt{}, ErrExternalNotFound
	}
	return s.receipt, nil
}
func (s *externalStub) Cancel(context.Context, ExternalExecutionIdentity) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cancels++
	return s.cancelErr
}
func (s *externalStub) counts() (int, int, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.submits, s.lookups, s.cancels
}
func externalAllow(context.Context, ExternalExecutionRequest) error { return nil }
func TestExternalCoordinatorLostResponseRestartRecoversWithoutResubmit(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	r, _ := externalRequestFixture()
	stub := &externalStub{loseResponse: true}
	j, err := OpenExternalJournal(root, r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := NewExternalCoordinator(j, stub, externalAllow)
	if _, err = c.Start(ctx, r); !errors.Is(err, ErrExternalUnknown) {
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
	c, _ = NewExternalCoordinator(j, stub, externalAllow)
	receipt, err := c.Start(ctx, r)
	if err != nil || receipt.RemoteTaskID != "remote" {
		t.Fatal(err)
	}
	submits, lookups, _ := stub.counts()
	if submits != 1 || lookups != 1 {
		t.Fatal(submits, lookups)
	}
}
func TestExternalCoordinatorConcurrentSubmitAndRevokeInFlight(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	r, _ := externalRequestFixture()
	stub := &externalStub{submitEntered: make(chan struct{}), submitRelease: make(chan struct{})}
	j, err := OpenExternalJournal(root, r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	j2, err := OpenExternalJournal(root, r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	defer j2.Close()
	first, _ := NewExternalCoordinator(j, stub, externalAllow)
	second, _ := NewExternalCoordinator(j2, stub, externalAllow)
	done := make(chan error, 1)
	go func() { _, e := first.Start(ctx, r); done <- e }()
	<-stub.submitEntered
	if _, err = second.Start(ctx, r); err != nil {
		t.Fatal(err)
	}
	if err = second.Revoke(ctx, r.Identity.CallID); err != nil {
		t.Fatal(err)
	}
	close(stub.submitRelease)
	if err = <-done; !errors.Is(err, ErrExternalRevoked) {
		t.Fatal("late result exposed", err)
	}
	if _, err = second.Recover(ctx, r.Identity.CallID); !errors.Is(err, ErrExternalRevoked) {
		t.Fatal(err)
	}
	submits, lookups, cancels := stub.counts()
	if submits != 1 || lookups != 1 || cancels != 2 {
		t.Fatal(submits, lookups, cancels)
	}
}
func TestExternalCoordinatorRevocationSurvivesCancelFailureAndRestart(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	r, _ := externalRequestFixture()
	stub := &externalStub{cancelErr: errors.New("offline")}
	j, err := OpenExternalJournal(root, r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := NewExternalCoordinator(j, stub, externalAllow)
	if _, err = c.Start(ctx, r); err != nil {
		t.Fatal(err)
	}
	if err = c.Revoke(ctx, r.Identity.CallID); err == nil {
		t.Fatal("cancel failure hidden")
	}
	_ = j.Close()
	j, err = OpenExternalJournal(root, r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	c, _ = NewExternalCoordinator(j, stub, externalAllow)
	if _, err = c.Start(ctx, r); !errors.Is(err, ErrExternalRevoked) {
		t.Fatal(err)
	}
	if _, err = c.Recover(ctx, r.Identity.CallID); !errors.Is(err, ErrExternalRevoked) {
		t.Fatal(err)
	}
	submits, lookups, _ := stub.counts()
	if submits != 1 || lookups != 0 {
		t.Fatal(submits, lookups)
	}
}
func TestExternalCoordinatorCurrentAuthorizationAndCrashBeforeSubmit(t *testing.T) {
	ctx := context.Background()
	r, _ := externalRequestFixture()
	stub := &externalStub{}
	j, err := OpenExternalJournal(t.TempDir(), r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	denied := errors.New("permission denied")
	c, _ := NewExternalCoordinator(j, stub, func(context.Context, ExternalExecutionRequest) error { return denied })
	if _, err = c.Start(ctx, r); !errors.Is(err, denied) {
		t.Fatal(err)
	}
	if _, _, err = j.Load(ctx, r.Identity.CallID); !errors.Is(err, ErrExternalMissing) {
		t.Fatal("unauthorized intent saved", err)
	}
	if err = j.SaveIntent(ctx, r); err != nil {
		t.Fatal(err)
	}
	if claimed, e := j.claimSubmission(ctx, r.Identity.CallID); e != nil || !claimed {
		t.Fatal(claimed, e)
	}
	c, _ = NewExternalCoordinator(j, stub, externalAllow)
	if _, err = c.Start(ctx, r); !errors.Is(err, ErrExternalUnknown) {
		t.Fatal(err)
	}
	submits, lookups, _ := stub.counts()
	if submits != 0 || lookups != 1 {
		t.Fatal("crash caused resubmit", submits, lookups)
	}
}

func TestExternalRetryOriginalAfterCrashPreservesRequestAndDeduplicatesConfirmation(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	r, _ := externalRequestFixture()
	stub := &externalStub{loseResponse: true}
	j, err := OpenExternalJournal(root, r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	if err = j.SaveIntent(ctx, r); err != nil {
		t.Fatal(err)
	}
	if ok, e := j.claimSubmission(ctx, r.Identity.CallID); e != nil || !ok {
		t.Fatal(ok, e)
	}
	c, _ := NewExternalCoordinator(j, stub, externalAllow)
	if _, err = c.RetryOriginal(ctx, r.Identity.CallID, "confirmation-1"); !errors.Is(err, ErrExternalUnknown) {
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
	c, _ = NewExternalCoordinator(j, stub, externalAllow)
	receipt, err := c.RetryOriginal(ctx, r.Identity.CallID, "confirmation-1")
	if err != nil || receipt.Identity != r.Identity {
		t.Fatal(err)
	}
	submits, _, _ := stub.counts()
	if submits != 1 {
		t.Fatal("confirmation resubmitted", submits)
	}
	stub.mu.Lock()
	sent := cloneExternalRequest(stub.lastRequest)
	stub.mu.Unlock()
	if sent.InputDigest != r.InputDigest || sent.Identity != r.Identity || string(sent.Input) != string(r.Input) {
		t.Fatal("original request rewritten")
	}
}
func TestExternalRetryRejectsUnknownCapabilityDriftAndKnownReceipt(t *testing.T) {
	for _, scenario := range []string{"timeout", "capability", "known_receipt", "revoked"} {
		t.Run(scenario, func(t *testing.T) {
			ctx := context.Background()
			r, _ := externalRequestFixture()
			stub := &externalStub{}
			j, err := OpenExternalJournal(t.TempDir(), r.Identity.Scope)
			if err != nil {
				t.Fatal(err)
			}
			defer j.Close()
			if err = j.SaveIntent(ctx, r); err != nil {
				t.Fatal(err)
			}
			if ok, e := j.claimSubmission(ctx, r.Identity.CallID); e != nil || !ok {
				t.Fatal(ok, e)
			}
			expected := ErrExternalUnknown
			switch scenario {
			case "timeout":
				stub.lookupErr = context.DeadlineExceeded
			case "capability":
				stub.unsafeRetry = true
				expected = ErrExternalCapability
			case "known_receipt":
				_, err = j.RecordReceipt(ctx, ExternalExecutionReceipt{Identity: r.Identity, InputDigest: r.InputDigest, RemoteTaskID: "known", Sequence: 1, State: ExternalRunning})
				if err != nil {
					t.Fatal(err)
				}
				expected = ErrExternalReceipt
			case "revoked":
				if err = j.revoke(ctx, r.Identity.CallID); err != nil {
					t.Fatal(err)
				}
				expected = ErrExternalRevoked
			}
			c, _ := NewExternalCoordinator(j, stub, externalAllow)
			if _, err = c.RetryOriginal(ctx, r.Identity.CallID, "confirmation"); !errors.Is(err, expected) {
				t.Fatal(err)
			}
			submits, _, _ := stub.counts()
			if submits != 0 {
				t.Fatal("unsafe retry submitted")
			}
		})
	}
}
func TestExternalRetryConfirmationConsumedBeforeCrashDoesNotResend(t *testing.T) {
	ctx := context.Background()
	r, _ := externalRequestFixture()
	stub := &externalStub{}
	j, err := OpenExternalJournal(t.TempDir(), r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	if err = j.SaveIntent(ctx, r); err != nil {
		t.Fatal(err)
	}
	if ok, e := j.claimSubmission(ctx, r.Identity.CallID); e != nil || !ok {
		t.Fatal(ok, e)
	}
	if ok, e := j.claimRetry(ctx, r.Identity.CallID, "consumed"); e != nil || !ok {
		t.Fatal(ok, e)
	}
	c, _ := NewExternalCoordinator(j, stub, externalAllow)
	if _, err = c.RetryOriginal(ctx, r.Identity.CallID, "consumed"); !errors.Is(err, ErrExternalUnknown) {
		t.Fatal(err)
	}
	submits, _, _ := stub.counts()
	if submits != 0 {
		t.Fatal("consumed confirmation retried")
	}
	if _, err = c.RetryOriginal(ctx, r.Identity.CallID, "new-explicit-confirmation"); err != nil {
		t.Fatal(err)
	}
	submits, _, _ = stub.counts()
	if submits != 1 {
		t.Fatal(submits)
	}
}

func TestExternalRetryConcurrentConfirmationUsesOneSubmission(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	r, _ := externalRequestFixture()
	stub := &externalStub{lookupErr: ErrExternalNotFound, submitEntered: make(chan struct{}), submitRelease: make(chan struct{})}
	j, err := OpenExternalJournal(root, r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	j2, err := OpenExternalJournal(root, r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	defer j2.Close()
	if err = j.SaveIntent(ctx, r); err != nil {
		t.Fatal(err)
	}
	if ok, e := j.claimSubmission(ctx, r.Identity.CallID); e != nil || !ok {
		t.Fatal(ok, e)
	}
	first, _ := NewExternalCoordinator(j, stub, externalAllow)
	second, _ := NewExternalCoordinator(j2, stub, externalAllow)
	done := make(chan error, 1)
	go func() { _, e := first.RetryOriginal(ctx, r.Identity.CallID, "same-confirmation"); done <- e }()
	<-stub.submitEntered
	_, err = second.RetryOriginal(ctx, r.Identity.CallID, "same-confirmation")
	close(stub.submitRelease)
	if !errors.Is(err, ErrExternalUnknown) {
		t.Fatal(err)
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	submits, _, _ := stub.counts()
	if submits != 1 {
		t.Fatal("duplicate submission", submits)
	}
}
