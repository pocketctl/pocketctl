package keepawake

// Request 是 CLI 经本地 socket 发给 daemon 的控制请求。
type Request struct {
	Cmd    string `json:"cmd"`    // 固定 "keep-awake"
	Action string `json:"action"` // "on" | "off" | "status"
}

// Response 是 daemon 的统一回复。
type Response struct {
	OK      bool   `json:"ok"`
	Enabled bool   `json:"enabled"`          // status/on/off 后的当前开关状态
	Reason  string `json:"reason,omitempty"` // inactive 时的原因（manual/battery-auto-off/...）
	OnBattery bool `json:"on_battery,omitempty"` // on 时是否检测到电池（提示自动关闭）
	Msg     string `json:"msg,omitempty"`
	Error   string `json:"error,omitempty"` // ok=false 时的错误描述
}
