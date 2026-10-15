package ws

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

const replayACKLimit = 100_000

// replayACKCache remembers complete logical facts confirmed by a contiguous
// Relay ACK. It filters historical hydration BEFORE transport expansion: an
// acknowledged multi-frame snapshot must not replay only its prefix chunks.
// Misses, corruption, persistence failures and eviction simply replay normally.
// All access is serialized by Client.outMu.
type replayACKCache struct {
	path    string
	keys    map[string]bool
	order   []string
	lines   int
	streams map[string]replayACKStream
}

type replayACKStream struct {
	next, bytes int
	valid       bool
}

// InitReplayACKs must be called before Run, after durable spool initialization.
func (c *Client) InitReplayACKs(dir string) error {
	// These unverified claims select an optimization namespace, never authority.
	// Relay independently verifies the token. Rotation keeps the namespace;
	// another account or destination must start with an empty ACK history.
	parts := strings.Split(c.token, ".")
	if len(parts) != 3 {
		return errors.New("replay ACK cache requires an account token")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return errors.New("invalid replay ACK account namespace")
	}
	var claims struct {
		UserID int64 `json:"userId"`
	}
	if json.Unmarshal(raw, &claims) != nil || claims.UserID <= 0 {
		return errors.New("missing replay ACK account namespace")
	}
	scope := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%d", c.relayURL, c.daemonID, claims.UserID)))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	cache := &replayACKCache{path: filepath.Join(dir, fmt.Sprintf("replay-acks-%x", scope[:16])), keys: make(map[string]bool)}
	file, err := os.Open(cache.path)
	if err == nil {
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			key := scanner.Text()
			if decoded, e := hex.DecodeString(key); e == nil && len(decoded) == sha256.Size {
				cache.add(key)
				cache.lines++
			}
		}
		scanErr := scanner.Err()
		file.Close()
		if scanErr != nil {
			return scanErr
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	c.replayACKs = cache
	return nil
}

func replayFactKey(id string) string {
	if len(id) > 4096 {
		return ""
	}
	parts := strings.Split(id, ":")
	if len(parts) < 4 {
		return ""
	}
	canonical := ""
	if parts[0] == "jsonl" && parts[1] != "" {
		if _, e := strconv.ParseUint(parts[2], 10, 64); e != nil {
			return ""
		}
		if _, e := strconv.ParseUint(parts[3], 10, 64); e != nil {
			return ""
		}
		canonical = id
	} else if parts[0] == "codex" {
		if _, e := strconv.ParseUint(parts[1], 10, 64); e != nil {
			return ""
		}
		switch parts[2] {
		case "user", "command", "file", "file-change", "tool", "compaction", "usage":
		case "part":
			if len(parts) < 6 || parts[4] != "final" {
				return ""
			}
		default:
			return "" // Deltas and process-local snapshots are not durable facts.
		}
		canonical = "codex-native:" + strings.Join(parts[2:], ":")
	}
	if canonical == "" {
		return ""
	}
	hash := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(hash[:])
}

func (r *replayACKCache) contains(id string) bool {
	return r != nil && r.keys[replayFactKey(id)]
}
func (r *replayACKCache) add(key string) {
	if r.keys[key] {
		return
	}
	if len(r.order) >= replayACKLimit {
		delete(r.keys, r.order[0])
		r.order = r.order[1:]
	}
	r.keys[key] = true
	r.order = append(r.order, key)
}
func (r *replayACKCache) record(ids []string) error {
	if r == nil {
		return nil
	}
	pending := make(map[string]bool)
	var keys []string
	for _, id := range ids {
		key := replayFactKey(id)
		if key != "" && !r.keys[key] && !pending[key] {
			pending[key] = true
			keys = append(keys, key)
		}
	}
	if len(keys) == 0 {
		return nil
	}
	// Leading newline isolates an incomplete trailing write after a crash.
	file, err := os.OpenFile(r.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	_, err = file.WriteString("\n" + strings.Join(keys, "\n") + "\n")
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	for _, key := range keys {
		r.add(key)
	}
	r.lines += len(keys)
	if r.lines >= 2*replayACKLimit {
		tmp := r.path + ".tmp"
		if err := os.WriteFile(tmp, []byte(strings.Join(r.order, "\n")+"\n"), 0600); err != nil {
			return err
		}
		if err := os.Rename(tmp, r.path); err != nil {
			return err
		}
		r.lines = len(r.order)
	}
	return nil
}

// Observe actual ACKed bytes, including prefixes that carry no source ID.
// A repaired/missing chunk or a process crash that lost prefix observations
// makes completeness unprovable: conservatively allow the source to replay.
func (r *replayACKCache) acknowledged(events []bufferedEvent, upto int64) []string {
	if r == nil {
		return nil
	}
	if r.streams == nil {
		r.streams = make(map[string]replayACKStream)
	}
	var ids []string
	for _, event := range events {
		if event.seq > upto {
			break
		}
		var wire protocol.DaemonEvent
		if json.Unmarshal(event.data, &wire) != nil || wire.Type == "event_delivery_error" {
			continue
		}
		if wire.Streaming {
			if wire.StreamID == "" {
				continue
			}
			state, exists := r.streams[wire.StreamID]
			if !exists {
				state.valid = true
			}
			content, supported := eventContent(wire)
			if !supported || wire.ChunkSeq == nil || wire.ByteOffset == nil || *wire.ChunkSeq != state.next || *wire.ByteOffset != state.bytes {
				state.valid = false
			}
			state.next++
			state.bytes += len(content)
			if wire.Final {
				delete(r.streams, wire.StreamID)
				if !state.valid || wire.TotalBytes != state.bytes {
					continue
				}
			} else {
				// Bounded diagnostics state; eviction is only a cache miss, never loss.
				if exists || len(r.streams) < 1024 {
					r.streams[wire.StreamID] = state
				}
				continue
			}
		}
		if wire.EventID != "" {
			ids = append(ids, wire.EventID)
		}
	}
	return ids
}
