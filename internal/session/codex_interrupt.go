package session

import (
	"context"
	"encoding/json"
	"time"

	"github.com/pocketctl/pocketctl/internal/codexapp"
)

// confirmInterruptedTurn repairs a missed completion using native history.
// A different/newer turn, an active turn or an unavailable runtime is never
// evidence that this request succeeded. Regular notifications remain primary.
func (b *CodexAppServerBackend) confirmInterruptedTurn(client codexRuntimeClient, generation uint64, sessionID, turnID string) bool {
	_, revision := b.coord.turnSnapshot(sessionID)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var response struct {
		Data []struct {
			ID     string          `json:"id"`
			Status string          `json:"status"`
			Error  json.RawMessage `json:"error"`
		} `json:"data"`
	}
	if err := client.Call(ctx, "thread/turns/list", map[string]any{"threadId": sessionID, "limit": 1}, &response); err != nil || len(response.Data) != 1 {
		return false
	}
	native := response.Data[0]
	if native.ID != turnID {
		return false
	}
	switch native.Status {
	case "interrupted", "cancelled", "completed", "failed":
	default:
		return false
	}
	if !b.coord.admissionGenerationCurrent(generation) {
		return false
	}
	if active, gen, ok := b.coord.backendClient(); ok && (active != client || gen != generation) {
		return false
	}
	b.coord.projectionMu.Lock()
	defer b.coord.projectionMu.Unlock()
	active, currentRevision := b.coord.turnSnapshot(sessionID)
	if currentRevision != revision || active != "" && active != turnID {
		return false
	}
	// Use the same projection and registry rules as a live completion; serialize
	// against live notifications so old evidence cannot idle a newer turn.
	raw, _ := json.Marshal(map[string]any{"threadId": sessionID, "turn": native})
	message := codexapp.Inbound{Method: "turn/completed", Params: raw}
	b.coord.observeTurnNotification(message)
	b.coord.publishProjected(newCodexProjection(generation).Project(message))
	return true
}
