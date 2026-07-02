//go:build darwin

package platform

import (
	"errors"
	"os/exec"
	"strings"
)

// NewPowerSource 返回基于 pmset 的 macOS 电源检测器。
//
// 实现：`pmset -g batt` 输出首行形如
//   "Now drawing from 'Battery Power'" / "Now drawing from 'AC Power'"
// 解析该行判断当前电源。
func NewPowerSource() PowerSource { return pmsetPowerSource{} }

type pmsetPowerSource struct{}

func (pmsetPowerSource) IsOnBattery() (bool, error) {
	out, err := exec.Command("pmset", "-g", "batt").Output()
	if err != nil {
		return false, err
	}
	// 首行包含电源来源标识。
	firstLine := out
	if i := strings.IndexByte(string(out), '\n'); i >= 0 {
		firstLine = out[:i]
	}
	s := string(firstLine)
	switch {
	case strings.Contains(s, "Battery Power"):
		return true, nil
	case strings.Contains(s, "AC Power"):
		return false, nil
	default:
		return false, errors.New("cannot determine power source from pmset output")
	}
}
