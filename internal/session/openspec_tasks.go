package session

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

var openSpecTaskPath = regexp.MustCompile(`^openspec/changes/([a-zA-Z0-9][a-zA-Z0-9_-]*)/tasks\.md$`)
var openSpecCheckbox = regexp.MustCompile(`^\s*[-*] \[([ xX])\]\s+(.+)$`)

// OpenSpecTasks watches only artifacts explicitly touched by a session. A cwd
// alone never binds every change in a repository to that session.
type OpenSpecTasks struct {
	statePath string
	mu        sync.Mutex
	bindings  map[string]*openSpecBinding
	cwd       func(string) (string, bool)
}
type openSpecBinding struct {
	Session, Root, Path, Hash, Previous, Parent string
	replay                                      bool
	Revision                                    int
	Published                                   bool
}

func NewOpenSpecTasks(cwd func(string) (string, bool)) *OpenSpecTasks {
	return &OpenSpecTasks{bindings: make(map[string]*openSpecBinding), cwd: cwd}
}
func (t *OpenSpecTasks) Observe(e protocol.DaemonEvent) {
	if e.SessionID == "" || e.AgentID != "" {
		return
	}
	switch e.Type {
	case "tool_use", "tool_call", "agent_file_change", "agent_file", "user_text":
	default:
		return
	}
	root, ok := t.cwd(e.SessionID)
	if !ok || root == "" {
		return
	}
	paths := []string{e.Path}
	if e.Type == "user_text" {
		fields := strings.Fields(e.Text)
		if len(fields) == 2 && (fields[0] == "/opsx:apply" || fields[0] == "/opsx-apply") {
			paths = append(paths, "openspec/changes/"+fields[1]+"/tasks.md")
		}
	}
	var input map[string]any
	if json.Unmarshal(e.Input, &input) == nil {
		for _, key := range []string{"file_path", "path", "command", "cmd"} {
			if p, ok := input[key].(string); ok {
				if key == "command" || key == "cmd" {
					paths = append(paths, strings.FieldsFunc(p, func(r rune) bool {
						return r == ' ' || r == '\n' || r == '\t' || r == '"' || r == '\'' || r == '`' || r == ';'
					})...)
				} else {
					paths = append(paths, p)
				}
			}
		}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, p := range paths {
		if p == "" {
			continue
		}
		if filepath.IsAbs(p) {
			var err error
			p, err = filepath.Rel(root, p)
			if err != nil {
				continue
			}
		}
		p = filepath.ToSlash(filepath.Clean(p))
		if !openSpecTaskPath.MatchString(p) {
			continue
		}
		key := e.SessionID + "\x00" + root + "\x00" + p
		if _, exists := t.bindings[key]; exists {
			continue
		}
		count := 0
		for _, b := range t.bindings {
			if b.Session == e.SessionID {
				count++
			}
		}
		if count >= 8 || len(t.bindings) >= 10000 {
			continue
		}
		t.bindings[key] = &openSpecBinding{Session: e.SessionID, Root: root, Path: p}
		t.saveBindings()
	}
}

func ParseOpenSpecTasks(data []byte) ([]protocol.PlanItem, error) {
	var items []protocol.PlanItem
	scan := bufio.NewScanner(strings.NewReader(string(data)))
	fence := ""
	for scan.Scan() {
		line := scan.Text()
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			marker := trimmed[:3]
			if fence == "" {
				fence = marker
			} else if fence == marker {
				fence = ""
			}
			continue
		}
		if fence != "" {
			continue
		}
		m := openSpecCheckbox.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		step := strings.TrimSpace(m[2])
		if len(step) > 4096 || len(items) >= 100 {
			return nil, errors.New("task list exceeds limit")
		}
		status := "pending"
		if m[1] != " " {
			status = "completed"
		}
		items = append(items, protocol.PlanItem{Step: step, Status: status})
	}
	return items, scan.Err()
}

func (t *OpenSpecTasks) Poll(now time.Time) []protocol.DaemonEvent {
	t.mu.Lock()
	defer t.mu.Unlock()
	var events []protocol.DaemonEvent
	for _, b := range t.bindings {
		currentRoot, exists := t.cwd(b.Session)
		if !exists || filepath.Clean(currentRoot) != filepath.Clean(b.Root) {
			continue
		}
		root, err := os.OpenRoot(b.Root)
		if err != nil {
			continue
		}
		f, err := root.Open(b.Path)
		root.Close()
		var data []byte
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) || !b.Published {
				continue
			}
		} else {
			stat, serr := f.Stat()
			if serr != nil || !stat.Mode().IsRegular() {
				f.Close()
				continue
			}
			data, err = io.ReadAll(io.LimitReader(f, 1<<20+1))
			f.Close()
			if err != nil || len(data) > 1<<20 {
				continue
			}
		}
		items, err := ParseOpenSpecTasks(data)
		if err != nil {
			continue
		}
		canonical, _ := json.Marshal(items)
		hash := sha256.Sum256(canonical)
		digest := hex.EncodeToString(hash[:])
		unchanged := b.Published && digest == b.Hash
		if unchanged && !b.replay {
			continue
		}
		revision := int(now.UnixMilli())
		if revision <= b.Revision {
			revision = b.Revision + 1
		}
		identity := sha256.Sum256([]byte(b.Root + "\x00" + b.Path))
		part := "openspec:" + b.Session + ":" + hex.EncodeToString(identity[:12])
		event := protocol.DaemonEvent{Type: "agent_plan", SessionID: b.Session, PartID: part, Revision: revision, PreviousEventID: b.Previous, Plan: items, TaskListTitle: "OpenSpec · " + openSpecTaskPath.FindStringSubmatch(b.Path)[1]}
		event.EventID = part + ":" + strconv.Itoa(revision) + ":" + digest
		if unchanged {
			event.EventID, event.PreviousEventID, event.Revision = b.Previous, b.Parent, b.Revision
			revision = b.Revision
		}
		b.replay = false
		if len(items) == 0 {
			event.Status = "cleared"
		}
		b.Parent = event.PreviousEventID
		b.Hash, b.Previous, b.Revision, b.Published = digest, event.EventID, revision, true
		events = append(events, event)
	}
	if len(events) > 0 {
		t.saveBindings()
	}
	return events
}
func (t *OpenSpecTasks) Run(ctx context.Context, out chan<- protocol.DaemonEvent) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			for _, event := range t.Poll(now) {
				select {
				case out <- event:
				case <-ctx.Done():
					return
				}
			}
		}
	}
}

// Bindings and causal identities survive daemon restarts; no task content is stored.
func (t *OpenSpecTasks) LoadBindings(path string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.statePath = path
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(data) > 4<<20 {
		return errors.New("OpenSpec bindings exceed limit")
	}
	var bindings map[string]*openSpecBinding
	if err = json.Unmarshal(data, &bindings); err != nil {
		return err
	}
	if len(bindings) > 10000 {
		return errors.New("too many OpenSpec bindings")
	}
	for key, b := range bindings {
		if b != nil && b.Session != "" && filepath.IsAbs(b.Root) && openSpecTaskPath.MatchString(b.Path) {
			b.replay = b.Published
			t.bindings[key] = b
		}
	}
	return nil
}
func (t *OpenSpecTasks) saveBindings() {
	if t.statePath == "" {
		return
	}
	data, err := json.Marshal(t.bindings)
	if err == nil {
		err = os.WriteFile(t.statePath+".tmp", data, 0600)
	}
	if err == nil {
		err = os.Rename(t.statePath+".tmp", t.statePath)
	}
	if err != nil {
		slog.Warn("save OpenSpec bindings", "error", err)
	}
}
