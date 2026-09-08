package zcode

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/pocketctl/pocketctl/internal/config"
)

// Destination state is independent of source identity: wire/event IDs stay
// stable, but a receipt from one Relay/account must never acknowledge another.
// Keep the journal in the same namespace as its cursor, including across token
// refreshes. Neither tokens nor account names appear in filenames.
func destinationStores(relayURL, accountID string) (*CursorStore, *PreparedEventJournal, error) {
	dir, err := config.ConfigDir()
	if err != nil {
		return nil, nil, err
	}
	return destinationStoresAt(dir, relayURL, accountID)
}

func destinationStoresAt(dir, relayURL, accountID string) (*CursorStore, *PreparedEventJournal, error) {
	u, err := url.Parse(relayURL)
	if err != nil || u.Host == "" || (u.Scheme != "ws" && u.Scheme != "wss") || strings.TrimSpace(accountID) == "" {
		return nil, nil, fmt.Errorf("zcode destination requires a WebSocket Relay URL and account identity")
	}
	u.Host = strings.ToLower(u.Host)
	u.Fragment = ""
	sum := sha256.Sum256([]byte(u.String() + "\x00" + accountID))
	suffix := hex.EncodeToString(sum[:16])
	cs := NewCursorStoreAt(filepath.Join(dir, "zcode-sync-cursor-"+suffix+".json"))
	j := NewPreparedEventJournalAt(filepath.Join(dir, "zcode-prepared-events-"+suffix+".jsonl"))
	if _, err := os.Stat(cs.Path()); err == nil {
		return cs, j, nil
	} else if !os.IsNotExist(err) {
		return nil, nil, err
	}

	// The unscoped cursor cannot prove which Relay received its content. Use
	// only its selected session IDs for bounded historical recovery, never its
	// ACKs, pending payloads or projection checkpoints. Preserve the original
	// files for rollback; do not reconcile the old content-bearing journal.
	next := emptyCursorFile()
	data, err := os.ReadFile(filepath.Join(dir, cursorFileName))
	if err != nil && !os.IsNotExist(err) {
		return nil, nil, err
	}
	if err == nil {
		var legacy CursorFile
		if err := json.Unmarshal(data, &legacy); err != nil {
			return nil, nil, fmt.Errorf("zcode legacy cursor is invalid")
		}
		if legacy.Version < 1 || legacy.Version > CursorVersion {
			return nil, nil, fmt.Errorf("zcode legacy cursor version %d requires migration", legacy.Version)
		}
		next.StoragePathHash, next.SourceID, next.SchemaFingerprint = legacy.StoragePathHash, legacy.SourceID, legacy.SchemaFingerprint
		for sid := range legacy.Sessions {
			next.Sessions[sid] = SessionCursor{}
		}
	}
	if err := cs.writeCursor(next); err != nil {
		return nil, nil, err
	}
	return cs, j, nil
}
