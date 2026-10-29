package agentteams

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

const MaxFrozenInputBytes = 64 * 1024 * 1024
const MaxFrozenIndexBytes = 512 * 1024
const MaxFrozenRequestBytes = 96 * 1024 * 1024

// HTTP JSON base64-encodes the already JSON-encoded original request.
const MaxFrozenWireBytes = 128 * 1024 * 1024

type InputFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Data   []byte `json:"data"`
}

func ValidateInputFiles(files []InputFile) error {
	if len(files) == 0 || len(files) > 129 {
		return ErrIdentity
	}
	seen := map[string]bool{}
	total := 0
	index := false
	for _, file := range files {
		if seen[file.Path] || len(file.Data) == 0 {
			return ErrIdentity
		}
		seen[file.Path] = true
		if file.Path == "inputs.json" {
			if len(file.Data) > MaxFrozenIndexBytes {
				return ErrIdentity
			}
			index = true
		} else {
			hash := strings.TrimPrefix(file.Path, "files/")
			decoded, err := hex.DecodeString(hash)
			if !strings.HasPrefix(file.Path, "files/") || err != nil || len(decoded) != 32 || strings.ToLower(hash) != hash || len(file.Data) > 2*1024*1024 {
				return ErrIdentity
			}
			total += len(file.Data)
		}
		digest := sha256.Sum256(file.Data)
		if file.SHA256 != hex.EncodeToString(digest[:]) {
			return ErrIdentity
		}
	}
	if !index || total > MaxFrozenInputBytes {
		return ErrIdentity
	}
	return nil
}
