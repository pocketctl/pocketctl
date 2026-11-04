package adapter

import (
	"encoding/json"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"path/filepath"
	"strings"
)

// Decode identity and invocation markers from the native envelope, never from
// assistant prose. Historical parsers do not grant trust: the manager must also
// have a new accepted command and an exact native root/parent binding.
func stampClaudeMemoryNative(line string, events []protocol.DaemonEvent) {
	var e JSONLEntry
	if json.Unmarshal([]byte(line), &e) != nil || e.UUID == "" || e.IsMeta {
		return
	}
	skill, unknownChild := false, false
	if e.Message != nil {
		var blocks []JSONLContentBlock
		_ = json.Unmarshal(e.Message.Content, &blocks)
		for _, b := range blocks {
			if b.Type != "tool_use" {
				continue
			}
			switch b.Name {
			case "Skill":
				skill = true
			case "Task", "Agent":
				unknownChild = true
			}
			if b.Name == "Read" {
				var input struct {
					FilePath string `json:"file_path"`
				}
				if json.Unmarshal(b.Input, &input) == nil && strings.EqualFold(filepath.Base(input.FilePath), "SKILL.md") {
					skill = true
				}
			}
		}
	}
	for i := range events {
		ev := &events[i]
		switch ev.Type {
		case "user_text", "agent_text", "tool_call", "tool_result":
		default:
			continue
		}
		ev.MemoryNative = &protocol.MemoryNativeEvent{Ordinal: i, Producer: "claude", RecordID: e.UUID, ParentRecordID: e.ParentUuid, RootID: ev.SourceTurnID, OccurredAt: e.Timestamp, UserRoot: e.Type == "user" && ev.Type == "user_text", Sidechain: e.IsSidechain, Skill: skill, UnknownChild: unknownChild}
	}
}

func stampClaudeStreamMemoryNative(root, line string, events []protocol.DaemonEvent) {
	var raw struct {
		Type    string         `json:"type"`
		Message *ClaudeMessage `json:"message"`
	}
	if json.Unmarshal([]byte(line), &raw) != nil || raw.Message == nil {
		return
	}
	skill, unknown := false, false
	for _, b := range raw.Message.Content {
		if b.Type == "tool_use" {
			skill = skill || strings.EqualFold(b.Name, "skill")
			unknown = unknown || b.Name == "Task" || b.Name == "Agent"
		}
	}
	for i := range events {
		ev := &events[i]
		switch ev.Type {
		case "agent_text", "tool_call", "tool_result":
		default:
			continue
		}
		record := raw.Message.ID
		if record == "" && ev.CallID != "" {
			record = ev.CallID + ":" + ev.Type
		}
		if record == "" {
			continue
		}
		ev.MemoryNative = &protocol.MemoryNativeEvent{Producer: "claude", RootID: root, RecordID: record, DirectRoot: true, Skill: skill, UnknownChild: unknown, Ordinal: i}
	}
}

func stampOpenCodeMemoryNative(ev *protocol.DaemonEvent, message OpencodeMessage, part *OpencodePart) {
	root := message.ParentID
	if strings.EqualFold(message.Role, "user") {
		root = message.ID
	}
	if root == "" || part.ID == "" {
		return
	}
	ev.MemoryNative = &protocol.MemoryNativeEvent{Producer: "opencode", RootID: root, RecordID: part.ID, DirectRoot: true, UserRoot: message.Role == "user", Skill: strings.EqualFold(part.Tool, "skill"), UnknownChild: part.Type == "subtask", CompleteCall: part.CallID != "" && part.Tool != "" && part.State != nil && len(part.State.Input) > 0}
}
