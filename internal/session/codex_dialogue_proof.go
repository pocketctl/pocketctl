package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// A shared app-server ACK authenticates one input. Its native clientId and a
// full, completed turn inventory are needed before certifying any output.
type codexDialogueInput struct {
	recorded                         time.Time
	root                             *protocol.MemorySourceProvenance
	nativeTurn, clientID, promptHash string
	generation                       uint64
}

// Decode only metadata and the two dialogue messages. Tool output and file diffs
// in the full native history are not needed by the attestation.
type codexCommandAction struct {
	Type    string `json:"type"`
	Path    string `json:"path"`
	Command string `json:"command"`
}
type codexDialogueFile struct {
	Kind     codexFileChangeKind `json:"kind"`
	MovePath string              `json:"movePath,omitempty"`
	Path     string              `json:"path"`
}
type codexDialogueItem struct {
	Changes        []codexDialogueFile  `json:"changes"`
	ID             string               `json:"id"`
	ClientID       string               `json:"clientId"`
	Type           string               `json:"type"`
	Phase          string               `json:"phase"`
	Text           string               `json:"text"`
	Content        json.RawMessage      `json:"content"`
	Command        string               `json:"command"`
	CommandActions []codexCommandAction `json:"commandActions"`
	PluginID       string               `json:"pluginId"`
	ScriptPath     string               `json:"scriptPath"`
	Source         string               `json:"source"`
}
type codexDialogueTurn struct {
	ID     string              `json:"id"`
	Status string              `json:"status"`
	View   string              `json:"itemsView"`
	Items  []codexDialogueItem `json:"items"`
}

func dialogueSHA(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
func (c *codexCoordinator) rememberDialogueInputLocked(in UserMessageInput, nativeTurn, logicalTurn, prompt string) {
	if c.dialogueInputs == nil {
		c.dialogueInputs = make(map[string]codexDialogueInput)
	}
	delete(c.dialogueInputs, in.SessionID)
	root := memoryInputProvenance(in, logicalTurn, "codex")
	if root == nil {
		return
	}
	if len(c.dialogueInputs) >= 512 {
		// Abandoned sessions may never publish a terminal notification.
		oldest := ""
		for id, entry := range c.dialogueInputs {
			if oldest == "" || entry.recorded.Before(c.dialogueInputs[oldest].recorded) {
				oldest = id
			}
		}
		delete(c.dialogueInputs, oldest)
	}
	c.dialogueInputs[in.SessionID] = codexDialogueInput{recorded: time.Now(), root: root, nativeTurn: nativeTurn, clientID: in.MsgID, promptHash: dialogueSHA(prompt), generation: c.generation}
}

// Accept simple native inspections only. A parsed subcommand cannot vouch
// for a pipeline, shell expansion, plugin, script, or an invocation of a skill.
var plainInspection = regexp.MustCompile(`^(cat|head|tail|ls|pwd|rg)($| [a-zA-Z0-9_./ :,-]+$)`)

var skillFile = regexp.MustCompile(`(?i)(^|[/\\[:space:]])(SKILL\.md($|[[:space:]])|\.(codex|claude)[/\\]skills[/\\])`)

func dialogueInspection(item *codexDialogueItem) bool {
	if (item.Source != "" && item.Source != "agent" && item.Source != "unifiedExecStartup") || item.PluginID != "" || item.ScriptPath != "" || len(item.CommandActions) != 1 || !plainInspection.MatchString(item.Command) {
		return false
	}
	a := item.CommandActions[0]
	if a.Command != item.Command || skillFile.MatchString(a.Path+" "+item.Command) {
		return false
	}
	// rg can start an external processor through flags or configuration.
	if strings.HasPrefix(item.Command, "rg ") && item.Command != "rg --files" {
		return false
	}
	return a.Type == "read" || a.Type == "listFiles" || a.Type == "search"
}

func (in codexDialogueInput) proof(t codexDialogueTurn) *protocol.MemorySourceProvenance {
	if t.ID != in.nativeTurn || t.Status != "completed" || t.View != "full" || len(t.Items) < 2 || len(t.Items) > 4096 {
		return nil
	}
	var user, answer *codexDialogueItem
	seen := make(map[string]bool, len(t.Items))
	for i := range t.Items {
		item := &t.Items[i]
		if item.ID == "" || seen[item.ID] {
			return nil
		}
		seen[item.ID] = true
		switch item.Type {
		case "userMessage":
			if i != 0 || item.ClientID != in.clientID {
				return nil
			}
			var parts []codexUserInput
			if json.Unmarshal(item.Content, &parts) != nil || len(parts) != 1 || parts[0].Type != "text" || parts[0].Role != "" || parts[0].Tag != "" || dialogueSHA(parts[0].Text) != in.promptHash {
				return nil
			}
			user = item
		case "agentMessage":
			if item.Phase == "commentary" {
				continue
			}
			if item.Phase != "final_answer" || i != len(t.Items)-1 || item.Text == "" {
				return nil
			}
			answer = item
		case "commandExecution":
			if !dialogueInspection(item) {
				return nil
			}
		case "fileChange":
			if len(item.Changes) == 0 || item.PluginID != "" {
				return nil
			}
			for _, change := range item.Changes {
				if change.Kind.Type != "add" && change.Kind.Type != "update" && change.Kind.Type != "delete" {
					return nil
				}
				if change.Path == "" || skillFile.MatchString(change.Path) || skillFile.MatchString(change.MovePath) || skillFile.MatchString(change.Kind.MovePath) {
					return nil
				}
			}
		case "reasoning", "plan":
		default:
			// Delegation, other tools, compaction, and future item types
			// need their own causal evidence. The text-only proof cannot cover them.
			return nil
		}
	}
	if user == nil || answer == nil || answer.ID == user.ID {
		return nil
	}
	root := in.root
	invocation := "dialogue:" + dialogueSHA(user.ID)
	identity := dialogueSHA(strings.Join([]string{root.SessionID, root.TurnID, root.EventID, invocation, in.promptHash, dialogueSHA(answer.ID), dialogueSHA(answer.Text)}, "\x00"))
	return &protocol.MemorySourceProvenance{
		Version: 1, Producer: "codex", SessionID: root.SessionID, TurnID: root.TurnID,
		EventID: "codex-dialogue-v1:" + identity, Sequence: "1", InvocationID: invocation,
		ParentInvocationID: root.InvocationID, SourceRole: "system", SkillState: "non_skill",
		LineageComplete: true, DerivedFromEventIDs: []string{root.EventID},
	}
}

func (c *codexCoordinator) completedDialogueProof(generation uint64, thread string, raw json.RawMessage) *protocol.MemorySourceProvenance {
	c.mu.Lock()
	input, pending := c.dialogueInputs[thread]
	c.mu.Unlock()
	if !pending || input.generation != generation {
		return nil
	}

	var params struct {
		Turn codexDialogueTurn `json:"turn"`
	}
	if json.Unmarshal(raw, &params) != nil {
		return nil
	}
	c.mu.Lock()
	in, ok := c.dialogueInputs[thread]
	if !ok || in.root != input.root || in.nativeTurn != params.Turn.ID || in.generation != generation || c.generation != generation || c.runtime == nil {
		c.mu.Unlock()
		return nil
	}
	delete(c.dialogueInputs, thread)
	client := c.runtime.Client
	c.mu.Unlock()
	if params.Turn.Status != "completed" {
		return nil
	}
	if params.Turn.View == "full" && len(params.Turn.Items) > 0 {
		return in.proof(params.Turn)
	}
	if client == nil {
		return nil
	}
	// Live terminal notifications may omit items. Only the exact finished turn
	// in a full response is eligible, even if a successor already exists.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var page struct {
		Data []codexDialogueTurn `json:"data"`
	}
	if client.Call(ctx, "thread/turns/list", map[string]any{"threadId": thread, "itemsView": "full", "sortDirection": "desc", "limit": 1}, &page) != nil || len(page.Data) != 1 {
		return nil
	}
	c.mu.Lock()
	current := c.generation == generation && c.runtime != nil && c.runtime.Client == client
	c.mu.Unlock()
	if !current {
		return nil
	}
	return in.proof(page.Data[0])
}
