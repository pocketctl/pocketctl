package agentteams

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestFrozenInputFilesRequireBoundedExactBytesAndCanonicalNames(t *testing.T) {
	file := func(path string, data []byte) InputFile {
		hash := sha256.Sum256(data)
		return InputFile{path, hex.EncodeToString(hash[:]), data}
	}
	index := file("inputs.json", []byte(`{"schema_version":1}`))
	proof := file("files/"+strings.Repeat("a", 64), []byte("proof"))
	if err := ValidateInputFiles([]InputFile{index, proof}); err != nil {
		t.Fatal(err)
	}
	for _, files := range [][]InputFile{nil, {proof}, {index, index}, {index, file("../../escape", []byte("x"))}, {index, {Path: proof.Path, SHA256: strings.Repeat("0", 64), Data: proof.Data}}, {file("inputs.json", make([]byte, MaxFrozenIndexBytes+1))}, {index, file(proof.Path, make([]byte, 2*1024*1024+1))}} {
		if err := ValidateInputFiles(files); err == nil {
			t.Fatal("invalid frozen inputs accepted")
		}
	}
}
