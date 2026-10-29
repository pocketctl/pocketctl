package agentteams

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// WorkerChat is a current tracker observation, not proof of a successful task.
// LastFinishedAt is used only to reconcile an original stop whose reply was lost.
type WorkerChat struct {
	ID             string `json:"id"`
	SessionID      string `json:"session_id"`
	Channel        string `json:"channel"`
	Status         string `json:"status"`
	LastFinishedAt string `json:"last_finished_at"`
}

func (c *WorkerClient) Chat(ctx context.Context, room string) (WorkerChat, error) {
	var empty WorkerChat
	if len(room) < 4 || len(room) > 256 || room[0] != '!' || !strings.Contains(room, ":") || strings.ContainsAny(room, "\x00\r\n ") {
		return empty, ErrIdentity
	}
	data, err := c.get(ctx, "/api/chats")
	if err != nil {
		return empty, err
	}
	var chats []WorkerChat
	if json.Unmarshal(data, &chats) != nil {
		return empty, ErrResponse
	}
	var found *WorkerChat
	for _, chat := range chats {
		if chat.SessionID != "matrix:"+room || chat.Channel != "agentteams_matrix" {
			continue
		}
		if found != nil || !safeID(chat.ID) || (chat.Status != "running" && chat.Status != "idle") {
			return empty, ErrIdentity
		}
		if chat.LastFinishedAt != "" {
			if _, err = time.Parse(time.RFC3339Nano, chat.LastFinishedAt); err != nil {
				return empty, ErrResponse
			}
		}
		value := chat
		found = &value
	}
	if found == nil {
		return empty, ErrResponse
	}
	return *found, nil
}

// StopChat uses only the exact UUID resolved from the original Matrix room.
// A false/missing response or still-running tracker remains unknown. Callers
// persist a stop intent before this I/O and reconcile lost replies separately.
func (c *WorkerClient) StopChat(ctx context.Context, room, expected string) (WorkerChat, error) {
	var empty WorkerChat
	chat, err := c.Chat(ctx, room)
	if err != nil {
		return empty, err
	}
	if chat.ID != expected {
		return empty, ErrIdentity
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/api/console/chat/stop?"+url.Values{"chat_id": {expected}}.Encode(), nil)
	if err != nil {
		return empty, ErrConfiguration
	}
	response, err := c.http.Do(req)
	if err != nil {
		return empty, ErrTransport
	}
	if response.StatusCode != 200 {
		response.Body.Close()
		return empty, &HTTPError{response.StatusCode}
	}
	data, err := readBounded(response, 4096)
	if err != nil {
		return empty, err
	}
	var result struct {
		Stopped *bool `json:"stopped"`
	}
	if json.Unmarshal(data, &result) != nil || result.Stopped == nil || !*result.Stopped {
		return empty, ErrResponse
	}
	after, err := c.Chat(ctx, room)
	if err != nil {
		return empty, err
	}
	if after.ID != expected || after.Status != "idle" {
		return empty, ErrResponse
	}
	return after, nil
}
