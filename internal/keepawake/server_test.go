package keepawake

import (
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/platform"
)

// uniquePath 返回基于 pid+随机后缀的唯一 socket 路径，避免并发测试冲突。
func uniquePath(t *testing.T) string {
	t.Helper()
	return platform.NewIPCListener().DefaultPath(
		fmt.Sprintf("ka-test-%d-%d", os.Getpid(), time.Now().UnixNano()),
	)
}

// newTestServer 起一个绑定了 fake inhibitor 的真实 socket server。
func newTestServer(t *testing.T, onBattery bool) (*Server, *fakeInhibitor, string) {
	t.Helper()
	inh := &fakeInhibitor{}
	m := newManagerWith(inh, fakePower{onBattery: onBattery}, nil)
	path := uniquePath(t)
	srv := NewServer(path, m, nil)
	if err := srv.Start(); err != nil {
		t.Fatalf("Start server: %v", err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return srv, inh, path
}

// 测试 on → off → status 完整往返。
func TestServerOnOffStatusRoundTrip(t *testing.T) {
	_, inh, path := newTestServer(t, false)

	// on
	resp, err := Ask(path, Request{Cmd: "keep-awake", Action: "on"})
	if err != nil {
		t.Fatalf("Ask on: %v", err)
	}
	if !resp.OK || !resp.Enabled {
		t.Fatalf("on resp: %+v", resp)
	}
	if ac, _ := inh.counts(); ac != 1 {
		t.Fatalf("expected 1 Acquire, got %d", ac)
	}

	// status
	resp, err = Ask(path, Request{Cmd: "keep-awake", Action: "status"})
	if err != nil {
		t.Fatalf("Ask status: %v", err)
	}
	if !resp.OK || !resp.Enabled {
		t.Fatalf("status resp: %+v", resp)
	}

	// off
	resp, err = Ask(path, Request{Cmd: "keep-awake", Action: "off"})
	if err != nil {
		t.Fatalf("Ask off: %v", err)
	}
	if !resp.OK || resp.Enabled {
		t.Fatalf("off resp: %+v", resp)
	}
	if _, rc := inh.counts(); rc != 1 {
		t.Fatalf("expected 1 Release, got %d", rc)
	}
}

// 测试 on 时若在电池上，响应携带 OnBattery=true。
func TestServerOnBatteryFlag(t *testing.T) {
	_, _, path := newTestServer(t, true) // onBattery
	resp, err := Ask(path, Request{Cmd: "keep-awake", Action: "on"})
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if !resp.OK {
		t.Fatalf("resp: %+v", resp)
	}
	if !resp.OnBattery {
		t.Fatalf("expected OnBattery=true, got %+v", resp)
	}
}

// 测试 unknown action 返回 ok=false。
func TestServerUnknownAction(t *testing.T) {
	_, _, path := newTestServer(t, false)
	resp, err := Ask(path, Request{Cmd: "keep-awake", Action: "bogus"})
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if resp.OK {
		t.Fatalf("unknown action should fail, got %+v", resp)
	}
}

// 测试未知 cmd 被拒绝。
func TestServerUnknownCmd(t *testing.T) {
	_, _, path := newTestServer(t, false)
	resp, err := Ask(path, Request{Cmd: "whatever", Action: "on"})
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if resp.OK {
		t.Fatalf("unknown cmd should fail, got %+v", resp)
	}
}

// 测试 Ask 拨号到不存在的 socket 返回错误（daemon 未运行场景）。
func TestAskDaemonNotRunning(t *testing.T) {
	_, err := Ask(uniquePath(t), Request{Cmd: "keep-awake", Action: "status"})
	if err == nil {
		t.Fatal("Ask to non-existent socket should error")
	}
}
