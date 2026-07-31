//go:build !darwin && !windows

package platform

// NewSleepInhibitor 在非 macOS/Windows 平台（如 Linux 服务器）返回不支持错误。
// sleep_other.go 与 sleep_darwin.go/sleep_windows.go 三选一编译：
// Linux 不自动待机（systemd-logind 默认 IdleAction=ignore），故特性在此平台关闭，
// 但 daemon 仍能正常启动，仅 keep-awake 功能不可用（受控降级）。
func NewSleepInhibitor() SleepInhibitor { return unsupportedSleepInhibitor{} }

type unsupportedSleepInhibitor struct{}

func (unsupportedSleepInhibitor) Acquire() error { return ErrUnsupported }
func (unsupportedSleepInhibitor) Release() error { return nil } // 释放永远成功，便于幂等清理
