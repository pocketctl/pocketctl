//go:build !windows

package daemon

// StartControlChannel Unix no-op(SIGTERM 由 signal.Notify 处理,不需要控制通道)。
func StartControlChannel(onStop func()) error {
	return nil
}
