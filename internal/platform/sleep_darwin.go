//go:build darwin

package platform

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"sync"
)

// NewSleepInhibitor 返回基于 caffeinate 的 macOS 休眠抑制器。
//
// 实现原理：起 `caffeinate -i -w <daemon-pid>` 子进程持续持有 idle 抑制。
// - `-i` 阻止系统空闲休眠。
// - `-w <pid>` 让 caffeinate 在指定进程（daemon）退出时自动终止——双重保险：
//   即便 Release 未被调用或 daemon 被 SIGKILL，caffeinate 也会随之退出，
//   绝不会成为永久占用资源的孤儿进程。
func NewSleepInhibitor() SleepInhibitor { return &caffeinateInhibitor{} }

type caffeinateInhibitor struct {
	mu   sync.Mutex
	cmd  *exec.Cmd
	held bool
}

func (c *caffeinateInhibitor) Acquire() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.held {
		return nil // 幂等：已持有
	}
	// -w 绑定 daemon 自身 pid：daemon 退出 → caffeinate 自动终止。
	pid := strconv.Itoa(os.Getpid())
	cmd := exec.Command("caffeinate", "-i", "-w", pid)
	// caffeinate 不需要 stdin/控制终端；脱离以避免被信号误伤。
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start caffeinate: %w", err)
	}
	c.cmd = cmd
	c.held = true
	return nil
}

func (c *caffeinateInhibitor) Release() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.held || c.cmd == nil || c.cmd.Process == nil {
		c.held = false
		return nil // 幂等：未持有
	}
	// 杀掉 caffeinate 即释放抑制。Wait 回收资源，避免僵尸进程。
	_ = c.cmd.Process.Kill()
	_ = c.cmd.Wait()
	c.cmd = nil
	c.held = false
	return nil
}
