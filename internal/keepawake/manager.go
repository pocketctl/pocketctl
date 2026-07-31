package keepawake

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/platform"
)

// batteryPollInterval 是 WatchForBattery 检测电源状态的间隔。
// 取 60s：足够及时（电池切换很少几秒内导致关机），又避免高频 pmset/GetSystemPowerStatus 开销。
const batteryPollInterval = 60 * time.Second

// ErrUnsupported 表示当前平台不支持 keep-awake。由 NewManager 包装透出。
var ErrUnsupported = platform.ErrUnsupported

// Manager 持有休眠抑制器的开关状态，并提供电池保护（自动关闭）。
// 线程安全；所有方法幂等。
type Manager struct {
	mu         sync.Mutex
	active     bool
	lastReason string // 最后一次进入 inactive 的原因（manual/battery-auto-off/shutdown/""）

	inhibitor platform.SleepInhibitor
	power     platform.PowerSource
	logger    *slog.Logger
}

// NewManager 构造一个绑定了平台抑制器与电源检测器的 Manager。
// logger 为 nil 时用 slog.Default()。
func NewManager(logger *slog.Logger) *Manager {
	if logger == nil {
		logger = slog.Default()
	}
	return &Manager{
		inhibitor: platform.NewSleepInhibitor(),
		power:     platform.NewPowerSource(),
		logger:    logger,
	}
}

// newManagerWith 是测试专用构造器，允许注入假的 inhibitor/power。
func newManagerWith(inhibitor platform.SleepInhibitor, power platform.PowerSource, logger *slog.Logger) *Manager {
	if logger == nil {
		logger = slog.Default()
	}
	return &Manager{
		inhibitor: inhibitor,
		power:     power,
		logger:    logger,
	}
}

// Enable 开启休眠抑制。幂等：已开启则 no-op。
// 返回 onBattery 标志，供调用方（CLI 响应）提示用户「当前电池供电，将自动关闭」。
//   onBattery=true 并不代表开启失败——仍会成功开启，但下一次电池轮询会自动关闭。
func (m *Manager) Enable() (onBattery bool, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active {
		// 已开启：仍探测一次电源以便返回准确提示，但本身是 no-op。
		b, _ := m.probeBattery()
		return b, nil
	}
	if err := m.inhibitor.Acquire(); err != nil {
		return false, err
	}
	m.active = true
	m.lastReason = ""
	b, _ := m.probeBattery()
	return b, nil
}

// Disable 关闭休眠抑制并记录原因。幂等：已关闭则更新 reason 后 no-op。
func (m *Manager) Disable(reason string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.active {
		// 未开启：仅刷新 reason（保留更"新"的事件，但不覆盖更重要的 battery）。
		if reason != "" && m.lastReason != ReasonBattery {
			m.lastReason = reason
		}
		return nil
	}
	if err := m.inhibitor.Release(); err != nil {
		m.logger.Warn("keep-awake: inhibitor release failed", "error", err)
		// 仍标记为 inactive：进程退出时 caffeinate -w 会兜底；Windows 线程状态会失效。
	}
	m.active = false
	m.lastReason = reason
	return nil
}

// Status 返回当前开关状态与上次进入 inactive 的原因。
func (m *Manager) Status() (active bool, reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.active, m.lastReason
}

// IsSupported 报告当前平台是否支持 keep-awake（probe Acquire 不真正改变状态）。
// 通过尝试一次幂等 Acquire/Release 来判定——平台 stub 直接返回 ErrUnsupported。
func (m *Manager) IsSupported() bool {
	if err := m.inhibitor.Acquire(); err != nil {
		return false
	}
	_ = m.inhibitor.Release()
	return true
}

// WatchForBattery 在后台定期检测电源；当处于 active 且检测到电池供电时自动 Disable。
// 受 ctx 管控，daemon 关闭时退出。探测本身失败时保守地不触发关闭（避免误伤）。
//
// 注意：此方法阻塞，应由 daemon 在独立 goroutine（如 daemon.RunLoop）中调用。
func (m *Manager) WatchForBattery(ctx context.Context) {
	t := time.NewTicker(batteryPollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.checkOnce(ctx)
		}
	}
}

// checkOnce 执行一次电池检测。导出仅便于测试注入时间/状态；非公开 API。
func (m *Manager) checkOnce(ctx context.Context) {
	m.mu.Lock()
	if !m.active {
		m.mu.Unlock()
		return
	}
	m.mu.Unlock()

	onBattery, err := m.probeBattery()
	if err != nil {
		// 无法判定电源：保守地不动作，记录后返回（不中断 watcher）。
		m.logger.Debug("keep-awake: power source probe failed", "error", err)
		return
	}
	if !onBattery {
		return
	}
	m.logger.Info("keep-awake: switched to battery power, auto-disabling to protect charge")
	if err := m.Disable(ReasonBattery); err != nil {
		m.logger.Warn("keep-awake: auto-disable failed", "error", err)
	}
}

// probeBattery 不持锁地查询电源。错误视为「无法判定」。
func (m *Manager) probeBattery() (bool, error) {
	b, err := m.power.IsOnBattery()
	if err != nil {
		return false, err
	}
	return b, nil
}

// IsUnsupported 报告 err 是否为本平台不支持 keep-awake。
func IsUnsupported(err error) bool {
	return errors.Is(err, platform.ErrUnsupported)
}
