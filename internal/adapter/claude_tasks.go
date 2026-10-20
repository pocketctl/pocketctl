package adapter

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Task snapshots are derived only from acknowledged tools, never assistant prose.
// Each parser owns a session's task state; replay reconstructs it in record order.
type claudeTaskState struct {
	seen      map[string]struct{}
	seenOrder []string
	pending   map[string]claudeTaskCall
	tasks     map[string]protocol.PlanItem
	order     []string
	previous  string
	revision  int
}
type claudeTaskCall struct {
	name  string
	input json.RawMessage
}

func (s *claudeTaskState) consume(line string) []protocol.DaemonEvent {
	var raw struct {
		Type            string `json:"type"`
		SessionID       string `json:"sessionId"`
		StreamSessionID string `json:"session_id"`
		Timestamp       string `json:"timestamp"`
		Sidechain       bool   `json:"isSidechain"`
		ToolResult      struct {
			Success *bool  `json:"success"`
			TaskID  string `json:"taskId"`
			Task    *struct {
				ID      string `json:"id"`
				Subject string `json:"subject"`
			} `json:"task"`
		} `json:"toolUseResult"`
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal([]byte(line), &raw) != nil || raw.Sidechain {
		return nil
	}
	sid := raw.SessionID
	if sid == "" {
		sid = raw.StreamSessionID
	}
	if sid == "" {
		return nil
	}
	var blocks []struct {
		Type      string          `json:"type"`
		ID        string          `json:"id"`
		Name      string          `json:"name"`
		Input     json.RawMessage `json:"input"`
		ToolUseID string          `json:"tool_use_id"`
		IsError   bool            `json:"is_error"`
	}
	if json.Unmarshal(raw.Message.Content, &blocks) != nil {
		return nil
	}
	var events []protocol.DaemonEvent
	for _, b := range blocks {
		if raw.Type == "assistant" && b.Type == "tool_use" && b.ID != "" {
			if b.Name != "TodoWrite" && b.Name != "TaskCreate" && b.Name != "TaskUpdate" {
				continue
			}
			if s.pending == nil {
				s.pending = make(map[string]claudeTaskCall)
			}
			// Bound unanswered calls. A malformed session must not grow state forever.
			if len(s.pending) < 512 {
				s.pending[b.ID] = claudeTaskCall{b.Name, b.Input}
			}
			continue
		}
		if raw.Type != "user" || b.Type != "tool_result" {
			continue
		}
		if _, duplicate := s.seen[b.ToolUseID]; duplicate {
			delete(s.pending, b.ToolUseID)
			continue
		}
		call, ok := s.pending[b.ToolUseID]
		if !ok {
			continue
		}
		delete(s.pending, b.ToolUseID)
		if s.seen == nil {
			s.seen = make(map[string]struct{})
		}
		if len(s.seenOrder) >= 1024 {
			delete(s.seen, s.seenOrder[0])
			s.seenOrder = s.seenOrder[1:]
		}
		s.seen[b.ToolUseID] = struct{}{}
		s.seenOrder = append(s.seenOrder, b.ToolUseID)
		if b.IsError || (raw.ToolResult.Success != nil && !*raw.ToolResult.Success) {
			continue
		}
		if s.tasks == nil {
			s.tasks = make(map[string]protocol.PlanItem)
		}
		switch call.name {
		case "TodoWrite":
			var input struct {
				Todos []struct {
					Content string `json:"content"`
					Status  string `json:"status"`
				} `json:"todos"`
			}
			if json.Unmarshal(call.input, &input) != nil || input.Todos == nil || len(input.Todos) > 100 {
				continue
			}
			tasks := make(map[string]protocol.PlanItem)
			order := make([]string, 0, len(input.Todos))
			valid := true
			for _, task := range input.Todos {
				if !validPlanStep(task.Content, task.Status) {
					valid = false
					break
				}
				key := "todo:" + strconv.Itoa(len(order))
				order = append(order, key)
				tasks[key] = protocol.PlanItem{Step: strings.TrimSpace(task.Content), Status: task.Status}
			}
			if !valid {
				continue
			}
			s.tasks = tasks
			s.order = order
		case "TaskCreate":
			task := raw.ToolResult.Task
			if task == nil || task.ID == "" || !validPlanStep(task.Subject, "pending") || len(s.tasks) >= 100 {
				continue
			}
			if _, exists := s.tasks[task.ID]; !exists {
				s.order = append(s.order, task.ID)
			}
			s.tasks[task.ID] = protocol.PlanItem{Step: strings.TrimSpace(task.Subject), Status: "pending"}
		case "TaskUpdate":
			var input struct {
				TaskID  string `json:"taskId"`
				Subject string `json:"subject"`
				Status  string `json:"status"`
			}
			if json.Unmarshal(call.input, &input) != nil || raw.ToolResult.Success == nil || !*raw.ToolResult.Success || raw.ToolResult.TaskID != input.TaskID {
				continue
			}
			task, exists := s.tasks[input.TaskID]
			if !exists {
				continue
			} // Never invent an unknown task's title/state.
			if input.Status == "deleted" {
				delete(s.tasks, input.TaskID)
				kept := s.order[:0]
				for _, id := range s.order {
					if id != input.TaskID {
						kept = append(kept, id)
					}
				}
				s.order = kept
			} else {
				if input.Subject != "" {
					task.Step = strings.TrimSpace(input.Subject)
				}
				if input.Status != "" {
					task.Status = input.Status
				}
				if !validPlanStep(task.Step, task.Status) {
					continue
				}
				s.tasks[input.TaskID] = task
			}
		}
		plan := make([]protocol.PlanItem, 0, len(s.tasks))
		for _, id := range s.order {
			if task, ok := s.tasks[id]; ok {
				plan = append(plan, task)
			}
		}
		status := ""
		if len(plan) == 0 {
			status = "cleared"
		}
		revision := s.revision + 1
		if stamp, err := time.Parse(time.RFC3339Nano, raw.Timestamp); err == nil && int(stamp.UnixMicro()) > revision {
			revision = int(stamp.UnixMicro())
		}
		eventID := "claude:plan:" + b.ToolUseID
		events = append(events, protocol.DaemonEvent{Type: "agent_plan", Status: status, SessionID: sid, EventID: eventID, PreviousEventID: s.previous, Revision: revision, Plan: plan})
		s.previous = eventID
		s.revision = revision
	}
	return events
}

func validPlanStep(step, status string) bool {
	return strings.TrimSpace(step) != "" && len(step) <= 4096 && (status == "pending" || status == "in_progress" || status == "completed")
}

// RestoreTaskState rehydrates acknowledged tasks when a stream-json resume starts.
func (a *ClaudeAdapter) RestoreTaskState(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	return restoreClaudeTasks(file, func(line string) { a.tasks.consume(line) })
}

// RestoreTaskState warms an EOF/cursor tailer without emitting historical events.
func (p *JSONLStreamParser) RestoreTaskState(reader io.Reader) error {
	return restoreClaudeTasks(reader, p.SeedTaskState)
}

func restoreClaudeTasks(reader io.Reader, consume func(string)) error {
	input := bufio.NewReader(reader)
	var record []byte
	oversized := false
	for {
		fragment, err := input.ReadSlice('\n')
		if !oversized {
			if len(record)+len(fragment) > 8*1024*1024 {
				record = nil
				oversized = true
			} else {
				record = append(record, fragment...)
			}
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if err == io.EOF {
			return nil
		} // A partial last record belongs to the next read.
		if err != nil {
			return err
		}
		if !oversized {
			consume(string(record))
		}
		record = nil
		oversized = false
	}
}
