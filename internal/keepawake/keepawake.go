// Package keepawake 提供「阻止系统休眠」能力，让用户在跑长 AI 任务时可手动
// 开启，避免机器因电源管理空闲超时而中断。语义为开关式（on/off/status），
// 用户通过本地 socket 命令显式控制；不会默认开启。
//
// 电池保护：开启后若检测到切换至电池供电，自动关闭以避免电量耗尽强制关机
// 反而中断任务。自动关闭不推送通知（用户需手动 status 查看）。
//
// 平台：macOS（caffeinate）、Windows（SetThreadExecutionState）。其他平台
// （如 Linux 服务器）返回 ErrUnsupported，daemon 仍正常运行，仅本特性不可用。
package keepawake

// 状态原因（lastReason 取值）。
const (
	// ReasonManual 用户主动执行 keep-awake off。空字符串表示从未关闭过/刚开启。
	ReasonManual = "manual"
	// ReasonBattery 因切换到电池供电被自动关闭。
	ReasonBattery = "battery-auto-off"
	// ReasonShutdown daemon 关闭流程中释放。
	ReasonShutdown = "shutdown"
	// ReasonAcquired 因平台错误在 Acquire 后立即回滚（实际未生效）。
	ReasonError = "acquire-error"
)
