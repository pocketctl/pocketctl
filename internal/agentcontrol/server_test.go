//go:build !windows

package agentcontrol

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeRuntimeProvider struct {
	acquires atomic.Int32
	delay    time.Duration
}

func (p *fakeRuntimeProvider) Acquire(ctx context.Context, req AcquireRequest) (AcquireResult, error) {
	p.acquires.Add(1)
	if p.delay > 0 {
		select {
		case <-time.After(p.delay):
		case <-ctx.Done():
			return AcquireResult{}, ctx.Err()
		}
	}
	return AcquireResult{Mode: string(LaunchManaged), BaseURL: "http://127.0.0.1:4096", Password: "secret", RealBinary: "/real/opencode", LeaseID: "lease-1", Generation: 7}, nil
}
func (*fakeRuntimeProvider) BindLease(context.Context, LeaseBindRequest) error { return nil }
func (*fakeRuntimeProvider) Release(context.Context, ReleaseRequest) error     { return nil }
func (*fakeRuntimeProvider) Status(context.Context, RuntimeStatusRequest) (RuntimeStatusResult, error) {
	return RuntimeStatusResult{Mode: string(LaunchManaged), Generation: 7}, nil
}

func TestAgentControlServerClientLifecycle(t *testing.T) {
	path := testSocketPath(t)
	if err := os.WriteFile(path, []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	provider := &fakeRuntimeProvider{}
	server := NewServer(path, map[string]RuntimeProvider{AgentOpenCode: provider})
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("socket info=%v err=%v", info, err)
	}
	client := NewClient(path)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result, err := client.Acquire(ctx, AcquirePayload{CWD: "/repo", Intent: IntentNew, OperationID: "op-1"})
	if err != nil || result.Generation != 7 || result.Password != "secret" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	status, err := client.Status(ctx, StatusPayload{})
	if err != nil || status.Generation != 7 {
		t.Fatalf("status=%+v err=%v", status, err)
	}
	if err := client.BindLease(ctx, LeaseBindPayload{LeaseID: "lease-1", PID: os.Getpid()}); err != nil {
		t.Fatal(err)
	}
	if err := client.Release(ctx, ReleasePayload{LeaseID: "lease-1"}); err != nil {
		t.Fatal(err)
	}
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("socket remains after close: %v", err)
	}
}

func TestAgentControlServerDeduplicatesConcurrentOperation(t *testing.T) {
	path := testSocketPath(t)
	provider := &fakeRuntimeProvider{delay: 40 * time.Millisecond}
	server := NewServer(path, map[string]RuntimeProvider{AgentOpenCode: provider})
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	client := NewClient(path)
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, err := client.Acquire(ctx, AcquirePayload{CWD: "/repo", Intent: IntentNew, OperationID: "same-op"})
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := provider.acquires.Load(); got != 1 {
		t.Fatalf("provider acquires=%d, want 1", got)
	}
}

func TestAgentControlServerRejectsOversizeFrameAndContinues(t *testing.T) {
	path := testSocketPath(t)
	server := NewServer(path, map[string]RuntimeProvider{AgentOpenCode: &fakeRuntimeProvider{}})
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Write(append(make([]byte, MaxFrameSize+1), '\n')); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	conn.Close()
	if err != nil {
		t.Fatal(err)
	}
	var resp Response
	if err := json.Unmarshal(line, &resp); err != nil || resp.Error == nil || resp.Error.Code != ErrInvalidRequest {
		t.Fatalf("response=%s err=%v", line, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := NewClient(path).Acquire(ctx, AcquirePayload{CWD: "/repo", Intent: IntentNew, OperationID: "after-large"}); err != nil {
		t.Fatal(err)
	}
}

func TestAgentControlServerDropsSlowClient(t *testing.T) {
	path := testSocketPath(t)
	server := NewServer(path, map[string]RuntimeProvider{AgentOpenCode: &fakeRuntimeProvider{}})
	server.ioTimeout = 30 * time.Millisecond
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	started := time.Now()
	if _, err := bufio.NewReader(conn).ReadByte(); err == nil {
		t.Fatal("slow connection remained open")
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("slow connection closed after %v", elapsed)
	}
}

func TestAgentControlServerReadTimeoutDoesNotCapProviderWork(t *testing.T) {
	path := testSocketPath(t)
	provider := &fakeRuntimeProvider{delay: 80 * time.Millisecond}
	server := NewServer(path, map[string]RuntimeProvider{AgentOpenCode: provider})
	server.ioTimeout = 30 * time.Millisecond
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result, err := NewClient(path).Acquire(ctx, AcquirePayload{CWD: "/repo", Intent: IntentNew, OperationID: "slow-provider"})
	if err != nil || result.Mode != string(LaunchManaged) {
		t.Fatalf("provider work was capped by frame read timeout: result=%+v err=%v", result, err)
	}
}

func testSocketPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "pocketctl-agent-control-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return filepath.Join(dir, "control.sock")
}

type cancelAwareProvider struct {
	fakeRuntimeProvider
	started  chan struct{}
	canceled chan struct{}
}

func (p *cancelAwareProvider) Acquire(ctx context.Context, _ AcquireRequest) (AcquireResult, error) {
	close(p.started)
	<-ctx.Done()
	close(p.canceled)
	return AcquireResult{}, ctx.Err()
}
func TestAgentControlDisconnectCancelsAcquire(t *testing.T) {
	path := testSocketPath(t)
	provider := &cancelAwareProvider{started: make(chan struct{}), canceled: make(chan struct{})}
	server := NewServer(path, map[string]RuntimeProvider{AgentCodex: provider})
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := NewAgentClient(path, AgentCodex).Acquire(ctx, AcquirePayload{CWD: "/repo", Intent: IntentNew, OperationID: "disconnect"})
		done <- err
	}()
	select {
	case <-provider.started:
	case <-time.After(time.Second):
		t.Fatal("acquire not started")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("canceled call succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("client ignored cancellation")
	}
	select {
	case <-provider.canceled:
	case <-time.After(time.Second):
		t.Fatal("abandoned acquire still running")
	}
}

type heldAcquireProvider struct {
	fakeRuntimeProvider
	started  chan struct{}
	proceed  chan struct{}
	released chan string
}

func (p *heldAcquireProvider) Acquire(context.Context, AcquireRequest) (AcquireResult, error) {
	if p.acquires.Add(1) == 1 {
		close(p.started)
	}
	<-p.proceed
	return AcquireResult{Mode: string(LaunchManaged), LeaseID: "held-lease"}, nil
}
func (p *heldAcquireProvider) Release(_ context.Context, req ReleaseRequest) error {
	p.released <- req.Payload.LeaseID
	return nil
}
func TestAgentControlDuplicateSurvivesOneCanceledWaiter(t *testing.T) {
	p := &heldAcquireProvider{started: make(chan struct{}), proceed: make(chan struct{}), released: make(chan string, 2)}
	s := NewServer(testSocketPath(t), nil)
	s.ctx = context.Background()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := AcquireRequest{Agent: AgentCodex, Payload: AcquirePayload{OperationID: "duplicate"}}
	first := make(chan error, 1)
	second := make(chan error, 1)
	go func() { _, err := s.acquireDeduplicated(ctx, p, req); first <- err }()
	<-p.started
	go func() { _, err := s.acquireDeduplicated(context.Background(), p, req); second <- err }()
	deadline := time.Now().Add(time.Second)
	for {
		s.mu.Lock()
		waiters := s.cache[AgentCodex+"\x00duplicate"].waiters
		s.mu.Unlock()
		if waiters == 2 {
			break
		}
		if time.Now().After(deadline) {
			close(p.proceed)
			t.Fatal("duplicate not waiting")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	if err := <-first; err == nil {
		t.Fatal("canceled waiter succeeded")
	}
	close(p.proceed)
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	s.wg.Wait()
	if p.acquires.Load() != 1 {
		t.Fatal("duplicate started competing acquire")
	}
	select {
	case <-p.released:
		t.Fatal("released live duplicate's lease")
	default:
	}
}
func TestAgentControlAbandonedAcquireReleasesLateLeaseBeforeRetry(t *testing.T) {
	p := &heldAcquireProvider{started: make(chan struct{}), proceed: make(chan struct{}), released: make(chan string, 2)}
	s := NewServer(testSocketPath(t), nil)
	s.ctx = context.Background()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := AcquireRequest{Agent: AgentCodex, Payload: AcquirePayload{OperationID: "retry"}}
	done := make(chan error, 1)
	go func() { _, err := s.acquireDeduplicated(ctx, p, req); done <- err }()
	<-p.started
	cancel()
	if err := <-done; err == nil {
		t.Fatal("canceled call succeeded")
	}
	// A slow provider may finish after cancellation. Do not let a retry create
	// the same lease until cleanup of that previous operation has completed.
	if _, err := s.acquireDeduplicated(context.Background(), p, req); err == nil {
		t.Fatal("retry raced abandoned operation")
	}
	close(p.proceed)
	s.wg.Wait()
	select {
	case lease := <-p.released:
		if lease != "held-lease" {
			t.Fatal(lease)
		}
	default:
		t.Fatal("abandoned lease leaked")
	}
	if _, err := s.acquireDeduplicated(context.Background(), p, req); err != nil {
		t.Fatal(err)
	}
	s.wg.Wait()
	if p.acquires.Load() != 2 {
		t.Fatal("canceled cache poisoned retry")
	}
}
