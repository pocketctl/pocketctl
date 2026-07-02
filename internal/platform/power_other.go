//go:build !darwin && !windows

package platform

// NewPowerSource 在非 macOS/Windows 平台返回不支持。
// 与 power_darwin.go/power_windows.go 三选一编译。
func NewPowerSource() PowerSource { return unsupportedPowerSource{} }

type unsupportedPowerSource struct{}

func (unsupportedPowerSource) IsOnBattery() (bool, error) {
	return false, ErrUnsupported
}
