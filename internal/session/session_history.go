package session

import (
	"context"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

type SessionHistoryReader func(
	ctx context.Context,
	sourceSessionID, targetSessionID, cursor string,
) (protocol.SessionHistoryReadResult, error)

func (sm *SessionManager) SetSessionHistoryReader(reader SessionHistoryReader) {
	sm.mu.Lock()
	sm.sessionHistoryReader = reader
	sm.mu.Unlock()
}

func (sm *SessionManager) getSessionHistoryReader() SessionHistoryReader {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.sessionHistoryReader
}
