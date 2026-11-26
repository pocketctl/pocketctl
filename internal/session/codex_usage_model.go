package session

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
)

// Native usage notifications identify the turn but omit its model. The
// started/resumed thread supplies the rollout path for this app-server HOME.
// Keep only turn metadata and a complete-line cursor, under the projector lock.
type codexUsageRollout struct {
	path   string
	file   os.FileInfo
	offset int64
	thread string
	models map[string]string
}

func (r *codexUsageRollout) modelForTurn(thread, turn string) string {
	if r == nil || turn == "" {
		return ""
	}
	f, err := os.Open(r.path)
	if err != nil {
		return ""
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	if r.file == nil || !os.SameFile(r.file, info) || info.Size() < r.offset {
		r.offset, r.thread = 0, ""
		r.models = make(map[string]string)
	}
	r.file = info
	if info.Size() > r.offset {
		// Snapshot EOF. A concurrent append or partial final line is picked
		// up by the next notification.
		input := bufio.NewReaderSize(io.NewSectionReader(f, r.offset, info.Size()-r.offset), 64<<10)
		for {
			line, err := input.ReadSlice('\n')
			size := int64(len(line))
			relevant := bytes.Contains(line, []byte(`"turn_context"`)) || bytes.Contains(line, []byte(`"session_meta"`))
			if err == bufio.ErrBufferFull {
				// Most large records are tool output or images. Discard their
				// continuation without allocating the entire record.
				if relevant {
					line = bytes.Clone(line)
				}
				for err == bufio.ErrBufferFull {
					var fragment []byte
					fragment, err = input.ReadSlice('\n')
					size += int64(len(fragment))
					if relevant {
						line = append(line, fragment...)
					}
				}
			}
			if err != nil {
				break
			}
			r.offset += size
			if relevant {
				r.observe(line, thread)
			}
		}
	}
	return r.models[turn]
}

func (r *codexUsageRollout) observe(line []byte, thread string) {
	var record struct {
		Type    string `json:"type"`
		Payload struct {
			ID     string `json:"id"`
			TurnID string `json:"turn_id"`
			Model  string `json:"model"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &record) != nil {
		return
	}
	switch record.Type {
	case "session_meta":
		r.thread = record.Payload.ID
	case "turn_context":
		turn, model := record.Payload.TurnID, strings.TrimSpace(record.Payload.Model)
		if r.thread == thread && turn != "" && model != "" {
			if previous, exists := r.models[turn]; exists && previous != model {
				// A turn with conflicting model evidence cannot identify the
				// model of an individual delayed usage notification.
				model = ""
			}
			r.models[turn] = model
		}
	}
}
