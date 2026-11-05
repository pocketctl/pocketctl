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
type claudeMemoryLink struct {
	parent  string
	emitted bool
	unknown bool
}

func (p *JSONLStreamParser) stampClaudeMemoryNative(line string, events []protocol.DaemonEvent) {
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

	// Preserve only native UUID edges through records with no public content.
	// Their bodies (including thinking/system context) never become evidence.
	root := p.turns.activeSource
	if root == "" {
		return
	}
	if p.memoryRoot != root {
		p.memoryRoot = root
		p.memoryLinks = map[string]claudeMemoryLink{}
	}
	if len(p.memoryLinks) >= 4096 {
		p.memoryLinks = map[string]claudeMemoryLink{}
	}
	emitted := false
	for _, ev := range events {
		if ev.Type == "user_text" || ev.Type == "agent_text" || ev.Type == "tool_call" || ev.Type == "tool_result" {
			emitted = true
		}
	}
	neutral := false
	if e.Type == "assistant" && e.Message != nil && !e.IsMeta {
		var blocks []JSONLContentBlock
		if json.Unmarshal(e.Message.Content, &blocks) == nil && len(blocks) > 0 {
			neutral = true
			for _, b := range blocks {
				if b.Type != "thinking" && b.Type != "redacted_thinking" {
					neutral = false
				}
			}
		}
	}
	if e.Type == "attachment" {
		var raw struct {
			Attachment struct {
				Type string `json:"type"`
			} `json:"attachment"`
		}
		if json.Unmarshal([]byte(line), &raw) == nil {
			switch raw.Attachment.Type {
			case "environment", "model", "language", "deferred_tools_delta", "agent_listing_delta", "skill_listing", "session_context", "date", "remote_session_change", "prompt_snapshot", "hook_success", "hook_additional_context":
				neutral = true
			}
		}
	}
	parent := e.ParentUuid
	seen := map[string]bool{}
	for len(seen) < 4096 {
		link, ok := p.memoryLinks[parent]
		if !ok || link.emitted {
			break
		}
		if seen[parent] {
			unknownChild = true
			break
		}
		seen[parent] = true
		unknownChild = unknownChild || link.unknown
		parent = link.parent
	}
	p.memoryLinks[e.UUID] = claudeMemoryLink{parent: e.ParentUuid, emitted: emitted, unknown: !neutral || e.IsSidechain}
	for i := range events {
		ev := &events[i]
		switch ev.Type {
		case "user_text", "agent_text", "tool_call", "tool_result":
		default:
			continue
		}
		ev.MemoryNative = &protocol.MemoryNativeEvent{Ordinal: i, Producer: "claude", RecordID: e.UUID, ParentRecordID: parent, RootID: ev.SourceTurnID, OccurredAt: e.Timestamp, UserRoot: e.Type == "user" && ev.Type == "user_text", Sidechain: e.IsSidechain, Skill: skill, UnknownChild: unknownChild}
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
			if b.Name == "Read" {
				var input struct {
					FilePath string `json:"file_path"`
				}
				if json.Unmarshal(b.Input, &input) == nil && strings.EqualFold(filepath.Base(input.FilePath), "SKILL.md") {
					skill = true
				}
			}
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
