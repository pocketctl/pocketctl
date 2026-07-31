//go:build windows

package platform

import (
	"fmt"
	"runtime"
	"sync"
	"syscall"
)

// SetThreadExecutionState 的执行状态标志（winbase.h）。
// 作用域：调用线程。线程退出或调用 ES_CONTINUOUS 清除后失效。
const (
	esContinuous        = 0x80000000 // 状态持续生效直到显式清除
	esSystemRequired    = 0x00000001 // 阻止系统进入休眠
	esAwayModeRequired  = 0x00000040 // Away 模式：外观休眠但后台运行（主板不支持时回退为普通抑制）
)

var procSetThreadExecutionState = syscall.NewLazyDLL("kernel32.dll").NewProc("SetThreadExecutionState")

// NewSleepInhibitor 返回基于 SetThreadExecutionState 的 Windows 休眠抑制器。
//
// 实现要点：SetThreadExecutionState 作用域是「调用线程」，必须保证 acquire/release
// 在同一线程调用。为此起一个专用 goroutine 并 runtime.LockOSThread() 钉住，
// 通过 channel 派发指令。daemon 退出时该 goroutine 随之终止，线程状态失效，
// 无需显式清理（与 macOS caffeinate -w 对等的崩溃兜底）。
func NewSleepInhibitor() SleepInhibitor { return &windowsInhibitor{} }

type windowsInhibitor struct {
	mu       sync.Mutex
	started  bool
	cmdCh    chan inhibitorCmd
	resultCh chan error
}

type inhibitorCmd int

const (
	cmdAcquire inhibitorCmd = iota
	cmdRelease
	cmdQuit
)

func (w *windowsInhibitor) Acquire() error {
	w.mu.Lock()
	if !w.started {
		w.cmdCh = make(chan inhibitorCmd, 1)
		w.resultCh = make(chan error, 1)
		go w.threadLoop()
		w.started = true
	}
	w.mu.Unlock()
	w.cmdCh <- cmdAcquire
	return <-w.resultCh
}

func (w *windowsInhibitor) Release() error {
	w.mu.Lock()
	if !w.started {
		w.mu.Unlock()
		return nil // 幂等：未持有
	}
	w.mu.Unlock()
	w.cmdCh <- cmdRelease
	return <-w.resultCh
}

// threadLoop 是钉在固定 OS 线程上的指令处理器。所有
// SetThreadExecutionState 调用都发生在此。
func (w *windowsInhibitor) threadLoop() {
	// 钉住当前 goroutine 到一个固定 OS 线程：执行状态只影响这个线程，
	// 且 acquire/release 复用同一线程（API 作用域要求）。
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	for cmd := range w.cmdCh {
		switch cmd {
		case cmdAcquire:
			w.resultCh <- setExecutionState(esContinuous | esSystemRequired | esAwayModeRequired)
		case cmdRelease:
			// ES_CONTINUOUS 单独 = 清除所有标志，恢复默认。
			w.resultCh <- setExecutionState(esContinuous)
		case cmdQuit:
			// 收尾：清除状态后退出（进程退出时线程自然终止，这里做幂等保护）。
			_ = setExecutionState(esContinuous)
			return
		}
	}
}

// setExecutionState 调用 Win32 API。返回的前一个状态值我们不需要，
// 仅检查调用是否成功（返回 0 表示失败）。
func setExecutionState(flags uint32) error {
	r1, _, _ := procSetThreadExecutionState.Call(uintptr(flags))
	if r1 == 0 {
		return fmt.Errorf("SetThreadExecutionState(0x%x) failed", flags)
	}
	return nil
}
