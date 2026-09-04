package memorysync

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestWireShapesMatchTheFrozenMemoryContract(t *testing.T) {
	start := StartCodeSnapshotRequest{
		Repository: RepositoryRef{
			RepositoryKey:   "github.com/example/repo",
			CanonicalRemote: "https://github.com/example/repo.git",
		},
		GitObjectFormat:     "sha1",
		CommitSHA:           strings.Repeat("a", 40),
		ManifestSHA256:      strings.Repeat("b", 64),
		ExpectedFileCount:   1,
		ExpectedByteCount:   3,
		ParserMatrixVersion: "phase4-v1",
		IdempotencyKey:      "idem-1",
	}
	encoded, err := json.Marshal(start)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"git_object_format":"sha1"`, `"commit_sha":"` + strings.Repeat("a", 40) + `"`,
		`"manifest_sha256":"` + strings.Repeat("b", 64) + `"`,
		`"expected_file_count":1`, `"expected_byte_count":3`,
		`"parser_matrix_version":"phase4-v1"`, `"idempotency_key":"idem-1"`,
		`"repository_key":"github.com/example/repo"`,
	} {
		if !strings.Contains(string(encoded), want) {
			t.Fatalf("start wire missing %s: %s", want, encoded)
		}
	}

	batch := CodeSnapshotFileBatch{
		BatchIndex: 0,
		Entries: []CodeSnapshotFileEntry{{
			Path:          "src/a.ts",
			GitMode:       "100644",
			Language:      "typescript",
			Capability:    "symbols_and_edges",
			BlobSHA256:    strings.Repeat("c", 64),
			ByteCount:     3,
			ContentBase64: "YWJj",
		}},
	}
	encodedBatch, err := json.Marshal(batch)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"batch_index":0`, `"path":"src/a.ts"`, `"git_mode":"100644"`,
		`"language":"typescript"`, `"capability":"symbols_and_edges"`,
		`"blob_sha256":"` + strings.Repeat("c", 64) + `"`,
		`"byte_count":3`, `"content_base64":"YWJj"`,
	} {
		if !strings.Contains(string(encodedBatch), want) {
			t.Fatalf("batch wire missing %s: %s", want, encodedBatch)
		}
	}

	finalize := FinalizeCodeSnapshotRequest{
		ManifestSHA256:    strings.Repeat("b", 64),
		ExpectedFileCount: 1,
		ExpectedByteCount: 3,
		IdempotencyKey:    "idem-1",
	}
	encodedFinalize, err := json.Marshal(finalize)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encodedFinalize), `"idempotency_key":"idem-1"`) {
		t.Fatalf("finalize wire: %s", encodedFinalize)
	}

	var wrapper jsonBatchWrapper
	if err := json.Unmarshal(encodedBatch, &wrapper); err != nil {
		t.Fatal(err)
	}
	if wrapper.BatchIndex != 0 || len(wrapper.Entries) != 1 || wrapper.Entries[0].Path != "src/a.ts" {
		t.Fatalf("batch decode mismatch: %+v", wrapper)
	}
	if wrapper.Entries[0].ContentBase64 != "YWJj" {
		t.Fatalf("content decode mismatch: %+v", wrapper.Entries[0])
	}
}

type jsonBatchWrapper struct {
	BatchIndex int                     `json:"batch_index"`
	Entries    []CodeSnapshotFileEntry `json:"entries"`
}
