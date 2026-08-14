package agentcontrol

import (
	"reflect"
)

// This file provides test-only reflection helpers used by the Task 1
// baseline tests in config_test.go. They encode the contract that Task 3
// MUST add a dedicated `Claude AgentConfig` field (JSON key "claude") to
// the Config struct, and they let the baseline tests fail loudly before
// that field exists — without requiring production code changes in Task 1.
//
// Per design §Task 1 Step 3: "不写生产实现,提交测试基线".

// claudeAgentConfigFieldReflectionPresent reports whether Config has a
// field whose JSON key is "claude". Returns false today (Config only has
// Version/OpenCode/Codex); returns true once Task 3 adds the field.
func claudeAgentConfigFieldReflectionPresent() bool {
	t := reflect.TypeOf(Config{})
	for i := 0; i < t.NumField(); i++ {
		if t.Field(i).Tag.Get("json") == "claude" {
			return true
		}
	}
	return false
}

// setClaudeAgentConfigViaReflection sets the Claude AgentConfig field on cfg
// via reflection. Called only after claudeAgentConfigFieldReflectionPresent
// returns true, so the field is guaranteed to exist.
func setClaudeAgentConfigViaReflection(cfg *Config, value AgentConfig) {
	v := reflect.ValueOf(cfg).Elem()
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		if t.Field(i).Tag.Get("json") == "claude" {
			v.Field(i).Set(reflect.ValueOf(value))
			return
		}
	}
}
