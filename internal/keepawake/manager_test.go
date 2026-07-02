package keepawake

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/platform"
)

// fakeInhibitor 是测试用的可编程抑制器。
type fakeInhibitor struct {
	mu          sync.Mutex
	acquired    bool
	acquireErr  error
	releaseErr  error
	acquireCnt  int
	releaseCnt  int
}

func (f *fakeInhibitor) Acquire() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.acquireCnt++
	if f.acquireErr != nil {
		return f.acquireErr
	}
	f.acquired = true
	return nil
}

func (f *fakeInhibitor) Release() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.releaseCnt++
	if f.releaseErr != nil {
		return f.releaseErr
	}
	f.acquired = false
	return nil
}

func (f *fakeInhibitor) counts() (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.acquireCnt, f.releaseCnt
}

type fakePower struct {
	onBattery bool
	err       error
}

func (p fakePower) IsOnBattery() (bool, error) { return p.onBattery, p.err }

// 测试 Enable 后 Status 反映 ON，Disable 后反映 OFF + manual reason。
func TestEnableDisableStatus(t *testing.T) {
	inh := &fakeInhibitor{}
	m := newManagerWith(inh, fakePower{onBattery: false}, nil)

	if active, _ := m.Status(); active {
		t.Fatal("initial state should be inactive")
	}

	if _, err := m.Enable(); err != nil {
		t.Fatalf("Enable: %v", err)
	}
	if active, _ := m.Status(); !active {
		t.Fatal("after Enable should be active")
	}
	if ac, _ := inh.counts(); ac != 1 {
		t.Fatalf("expected 1 Acquire, got %d", ac)
	}

	if err := m.Disable(ReasonManual); err != nil {
		t.Fatalf("Disable: %v", err)
	}
	if active, reason := m.Status(); active || reason != ReasonManual {
		t.Fatalf("after Disable: active=%v reason=%q", active, reason)
	}
	if _, rc := inh.counts(); rc != 1 {
		t.Fatalf("expected 1 Release, got %d", rc)
	}
}

// 测试 Enable 幂等：重复 Enable 不重复 Acquire。
func TestEnableIdempotent(t *testing.T) {
	inh := &fakeInhibitor{}
	m := newManagerWith(inh, fakePower{onBattery: false}, nil)

	if _, err := m.Enable(); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Enable(); err != nil {
		t.Fatal(err)
	}
	if ac, _ := inh.counts(); ac != 1 {
		t.Fatalf("idempotent Enable should Acquire once, got %d", ac)
	}
}

// 测试 Disable 幂等：未开启时 Disable 不报错也不 Release。
func TestDisableIdempotent(t *testing.T) {
	inh := &fakeInhibitor{}
	m := newManagerWith(inh, fakePower{onBattery: false}, nil)

	if err := m.Disable(ReasonManual); err != nil {
		t.Fatalf("Disable on inactive should be no-op, got %v", err)
	}
	if _, rc := inh.counts(); rc != 0 {
		t.Fatalf("Disable on inactive should not Release, got %d", rc)
	}
}

// 测试电池保护：active 时 checkOnce 检测到电池则自动 Disable，reason=battery-auto-off。
func TestBatteryAutoDisable(t *testing.T) {
	inh := &fakeInhibitor{}
	m := newManagerWith(inh, fakePower{onBattery: true}, nil)

	if _, err := m.Enable(); err != nil {
		t.Fatal(err)
	}
	m.checkOnce(context.Background()) // 立即触发一次轮询逻辑

	if active, _ := m.Status(); active {
		t.Fatal("should be auto-disabled on battery")
	}
	_, reason := m.Status()
	if reason != ReasonBattery {
		t.Fatalf("reason should be battery-auto-off, got %q", reason)
	}
	if _, rc := inh.counts(); rc != 1 {
		t.Fatalf("should Release once on auto-disable, got %d", rc)
	}
}

// 测试电源探测失败时不误触发关闭（保守策略）。
func TestBatteryProbeErrorNoDisable(t *testing.T) {
	inh := &fakeInhibitor{}
	m := newManagerWith(inh, fakePower{err: errors.New("probe failed")}, nil)

	if _, err := m.Enable(); err != nil {
		t.Fatal(err)
	}
	m.checkOnce(context.Background())

	if active, _ := m.Status(); !active {
		t.Fatal("probe error must NOT disable (conservative)")
	}
}

// 测试 inactive 时 checkOnce 不做任何事。
func TestCheckWhenInactive(t *testing.T) {
	inh := &fakeInhibitor{}
	m := newManagerWith(inh, fakePower{onBattery: true}, nil) // 不先 Enable

	m.checkOnce(context.Background())

	if _, rc := inh.counts(); rc != 0 {
		t.Fatalf("inactive checkOnce should not Release, got %d", rc)
	}
}

// 测试 Enable 在电池上仍开启成功，但返回 onBattery=true 提示。
func TestEnableOnBatteryReturnsFlag(t *testing.T) {
	inh := &fakeInhibitor{}
	m := newManagerWith(inh, fakePower{onBattery: true}, nil)

	onBattery, err := m.Enable()
	if err != nil {
		t.Fatal(err)
	}
	if !onBattery {
		t.Fatal("Enable should report onBattery=true when on battery")
	}
	if active, _ := m.Status(); !active {
		t.Fatal("should still be active immediately after Enable on battery")
	}
}

// 测试平台不支持：IsSupported 返回 false。
func TestUnsupportedPlatform(t *testing.T) {
	m := newManagerWith(unsupportedInh{}, fakePower{}, nil)
	if m.IsSupported() {
		t.Fatal("unsupported inhibitor should report IsSupported=false")
	}
	_, err := m.Enable()
	if !errors.Is(err, platform.ErrUnsupported) {
		t.Fatalf("Enable on unsupported should return ErrUnsupported, got %v", err)
	}
}

type unsupportedInh struct{}

func (unsupportedInh) Acquire() error { return platform.ErrUnsupported }
func (unsupportedInh) Release() error { return nil }

// 测试 WatchForBattery 在 ctx 取消时及时退出。
func TestWatchForBatteryExitsOnContextCancel(t *testing.T) {
	inh := &fakeInhibitor{}
	m := newManagerWith(inh, fakePower{onBattery: false}, nil)
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		m.WatchForBattery(ctx)
		close(done)
	}()

	// 即使间隔 60s，ctx 取消应立即唤醒 select 退出。
	cancel()
	select {
	case <-done:
		// ok
	case <-time.After(2 * time.Second):
		t.Fatal("WatchForBattery did not exit within 2s of ctx cancel")
	}
}
