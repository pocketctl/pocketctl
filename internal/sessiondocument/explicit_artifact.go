package sessiondocument

import (
	"fmt"
	"io"
	"path/filepath"
)

// ReadExplicitArtifact shares the document capture's no-follow file-descriptor
// traversal, but supports binary artifacts. The caller supplies an authorized
// root and an explicit relative path; this function never scans directories.
func ReadExplicitArtifact(root, relative string, maxBytes int) ([]byte, error) {
	normalized, ok := normalizeRelativePath(relative)
	if !ok || normalized != relative || maxBytes < 1 {
		return nil, fmt.Errorf("artifact_path_invalid")
	}
	f, err := secureOpenRegular(root, filepath.FromSlash(relative))
	if err != nil {
		return nil, fmt.Errorf("artifact_path_unreadable: %w", err)
	}
	defer f.Close()
	before, err := f.Stat()
	if err != nil || !before.Mode().IsRegular() || before.Size() > int64(maxBytes) {
		return nil, fmt.Errorf("artifact_size_invalid")
	}
	data, err := io.ReadAll(io.LimitReader(f, int64(maxBytes)+1))
	if err != nil || len(data) > maxBytes || len(data) == 0 {
		return nil, fmt.Errorf("artifact_read_failed")
	}
	after, err := f.Stat()
	if err != nil || before.Size() != int64(len(data)) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		return nil, fmt.Errorf("artifact_changed_during_read")
	}
	return data, nil
}
