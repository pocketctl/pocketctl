package adapter

import (
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// OpencodeDocumentCandidate stays local to the daemon. The capture callback
// must bind FilePath to the authorized session root before reading any bytes.
type OpencodeDocumentCandidate struct {
	SessionID     string
	TurnID        string
	ChangeSetID   string
	SourceEventID string
	FilePath      string
}

type opencodeDocumentFile struct {
	FilePath string `json:"filePath"`
	Type     string `json:"type"`
	MovePath string `json:"movePath"`
}

// OpencodeDocumentCandidates returns the latest successful write per document
// once the session is idle. Historical messages identify current disk snapshots,
// not historical file contents. Failed and in-progress tools are never sources.
func OpencodeDocumentCandidates(sessionID, directory string, msgs []OpencodeMessageWithParts, native *OpencodeSessionStatus) []OpencodeDocumentCandidate {
	if sessionID == "" || (native != nil && native.Type != protocol.StatusIdle) {
		return nil
	}
	ordered := append([]OpencodeMessageWithParts(nil), msgs...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Info.Time.Created < ordered[j].Info.Time.Created })
	if len(ordered) == 0 || ordered[len(ordered)-1].Info.Role != "assistant" || ordered[len(ordered)-1].Info.Time.Completed == 0 {
		return nil
	}
	if ordered[len(ordered)-1].Info.Finish == "tool-calls" {
		return nil
	}
	latest := map[string]OpencodeDocumentCandidate{}
	order := map[string]int{}
	latestAnchor := ""
	for _, message := range ordered {
		if message.Info.Role == "user" {
			latestAnchor = message.Info.ID
		}
	}
	anchor := ""
	sequence := 0
	for _, message := range ordered {
		if message.Info.Role == "user" {
			anchor = message.Info.ID
			continue
		}
		if message.Info.Role != "assistant" {
			continue
		}
		if message.Info.Time.Completed == 0 && len(message.Info.Error) == 0 {
			if anchor == latestAnchor {
				return nil
			}
			continue // An abandoned older turn must not block later documents.
		}
		if anchor == "" {
			continue
		}
		for _, part := range message.Parts {
			if part.Type != "tool" || part.State == nil || part.State.Status != "completed" || part.ID == "" {
				continue
			}
			for _, file := range opencodeDocumentFiles(part) {
				path := opencodeDocumentPath(directory, file.FilePath)
				if file.Type == "delete" || file.MovePath != "" {
					delete(latest, path)
				}
				if file.Type == "delete" {
					continue
				}
				if file.MovePath != "" {
					path = opencodeDocumentPath(directory, file.MovePath)
				}
				switch strings.ToLower(filepath.Ext(path)) {
				case ".md", ".markdown", ".html", ".htm":
				default:
					continue
				}
				event := protocol.DaemonEvent{}
				stampOpencodeTurn(&event, sessionID, anchor, 0)
				identity := sessionID + "\x00" + anchor + "\x00" + part.ID + "\x00" + path + "\x00" + string(opencodeCanonicalJSON(part.State))
				latest[path] = OpencodeDocumentCandidate{SessionID: sessionID, TurnID: event.TurnID,
					ChangeSetID:   "opencode-docset-" + opencodeContentHash(sessionID+"\x00"+part.ID),
					SourceEventID: "opencode-document-" + opencodeContentHash(identity), FilePath: path}
				sequence++
				order[path] = sequence
			}
		}
	}
	out := make([]OpencodeDocumentCandidate, 0, len(latest))
	for _, candidate := range latest {
		out = append(out, candidate)
	}
	sort.Slice(out, func(i, j int) bool { return order[out[i].FilePath] > order[out[j].FilePath] })
	if len(out) > 50 {
		out = out[:50]
	}
	return out
}

func opencodeDocumentPath(directory, path string) string {
	if !filepath.IsAbs(path) && directory != "" {
		return filepath.Join(directory, path)
	}
	return filepath.Clean(path)
}

func opencodeDocumentFiles(part OpencodePart) []opencodeDocumentFile {
	switch part.Tool {
	case "write", "edit":
		var input struct {
			FilePath string `json:"filePath"`
		}
		if json.Unmarshal(part.State.Input, &input) != nil || input.FilePath == "" {
			return nil
		}
		return []opencodeDocumentFile{{FilePath: input.FilePath}}
	case "apply_patch":
		var metadata struct {
			Files []opencodeDocumentFile `json:"files"`
		}
		if json.Unmarshal(part.State.Metadata, &metadata) != nil {
			return nil
		}
		var out []opencodeDocumentFile
		for _, file := range metadata.Files {
			if file.FilePath == "" {
				continue
			}
			switch file.Type {
			case "add", "update", "move", "delete":
				out = append(out, file)
			}
		}
		return out
	}
	return nil
}
