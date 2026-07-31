//go:build windows

package platform

import (
	"errors"
	"syscall"
	"unsafe"
)

// systemPowerStatus 镜像 Win32 SYSTEM_POWER_STATUS（winbase.h）。
// 字段顺序与对齐必须与原生结构一致，因为 GetSystemPowerStatus 写入的是裸结构。
type systemPowerStatus struct {
	ACLineStatus        uint8  // 0=电池, 1=外接电源, 255=未知
	BatteryFlag         uint8  // 1=高, 2=低, 4=临界, 8=充电中, 128=无电池, 255=未知
	BatteryLifePercent  uint8  // 0-100, 255=未知
	SystemStatusFlag    uint8  // 0=off, 1=On（节流模式）
	BatteryLifeTime     uint32 // 剩余秒数, 0xFFFFFFFF=未知
	BatteryFullLifeTime uint32 // 满电秒数, 0xFFFFFFFF=未知
}

var procGetSystemPowerStatus = syscall.NewLazyDLL("kernel32.dll").NewProc("GetSystemPowerStatus")

// NewPowerSource 返回基于 GetSystemPowerStatus 的 Windows 电源检测器。
func NewPowerSource() PowerSource { return windowsPowerSource{} }

type windowsPowerSource struct{}

func (windowsPowerSource) IsOnBattery() (bool, error) {
	var s systemPowerStatus
	// 传入结构指针；返回 0 表示失败。
	r1, _, _ := procGetSystemPowerStatus.Call(uintptr(unsafe.Pointer(&s)))
	if r1 == 0 {
		return false, errors.New("GetSystemPowerStatus failed")
	}
	switch s.ACLineStatus {
	case 0:
		return true, nil // 电池供电
	case 1:
		return false, nil // 外接电源
	default:
		// 255 或其他：无法判定，保守返回 error（不触发自动关闭）。
		return false, errors.New("AC line status unknown")
	}
}
