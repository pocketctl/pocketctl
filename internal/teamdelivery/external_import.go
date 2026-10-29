package teamdelivery

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path"
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/sessiondocument"
)

// ImportExternalDelivery freezes bytes from one authenticated remote submission
// into the existing Call output directory. It neither publishes nor accepts a
// delivery. Collect and the Relay publication gate still validate that contract.
func ImportExternalDelivery(ctx context.Context, workspace, callID string, read func(context.Context, string, int64) ([]byte, error)) (string, error) {
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if !textValid(callID, 128) || read == nil {
		return "", fmt.Errorf("external_delivery_identity_invalid")
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return "", err
	}
	defer root.Close()
	parent := ".pocketctl-deliveries"
	if err = root.Mkdir(parent, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", err
	}
	info, err := root.Lstat(parent)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("external_delivery_directory_invalid")
	}
	metadata, err := read(ctx, "submission.json", MaxManifestBytes)
	if err != nil {
		return "", err
	}
	if len(metadata) > MaxManifestBytes {
		return "", fmt.Errorf("external_delivery_manifest_limit")
	}
	var value manifest
	if err = decodeStrict(metadata, &value); err != nil {
		return "", err
	}
	if value.SchemaVersion != 1 || value.PublishScope != "team" || !textValid(value.Summary, 16000) || len(value.Artifacts) < 1 || len(value.Artifacts) > 16 {
		return "", fmt.Errorf("external_delivery_manifest_invalid")
	}
	files := map[string][]byte{"submission.json": metadata}
	ids := map[string]bool{}
	total := len(metadata)
	for _, artifact := range value.Artifacts {
		name := artifact.Path
		if !artifactID.MatchString(artifact.ID) || ids[artifact.ID] || artifact.Required == nil || !textValid(name, 1024) || path.IsAbs(name) || path.Clean(name) != name || name == "." || name == ".." || strings.HasPrefix(name, "../") || strings.ContainsAny(name, "\\\r\n") || name == "submission.json" {
			return "", fmt.Errorf("external_delivery_path_invalid")
		}
		if _, exists := files[name]; exists {
			return "", fmt.Errorf("external_delivery_path_duplicate")
		}
		ids[artifact.ID] = true
		data, err := read(ctx, name, MaxArtifactBytes)
		if err != nil {
			return "", err
		}
		total += len(data)
		if len(data) > MaxArtifactBytes || total > MaxSnapshotBytes {
			return "", fmt.Errorf("external_delivery_bytes_limit")
		}
		files[name] = append([]byte(nil), data...)
	}
	final := protocol.TeamDeliveryDirectory(callID)
	if info, err = root.Lstat(final); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("external_delivery_existing_invalid")
		}
		for name, data := range files {
			old, err := sessiondocument.ReadExplicitArtifact(workspace, final+"/"+name, MaxArtifactBytes)
			if err != nil || !bytes.Equal(old, data) {
				return "", fmt.Errorf("external_delivery_existing_changed")
			}
		}
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return value.Summary, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	random := make([]byte, 16)
	if _, err = rand.Read(random); err != nil {
		return "", err
	}
	stage := parent + "/.external-" + hex.EncodeToString(random)
	if err = root.Mkdir(stage, 0700); err != nil {
		return "", err
	}
	defer root.RemoveAll(stage)
	for name, data := range files {
		directory := stage
		parts := strings.Split(name, "/")
		for _, part := range parts[:len(parts)-1] {
			directory += "/" + part
			if err = root.Mkdir(directory, 0700); err != nil && !errors.Is(err, os.ErrExist) {
				return "", err
			}
			info, err = root.Lstat(directory)
			if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return "", fmt.Errorf("external_delivery_directory_invalid")
			}
		}
		file, err := root.OpenFile(stage+"/"+name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0400)
		if err != nil {
			return "", err
		}
		_, err = file.Write(data)
		if err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err != nil {
			return "", err
		}
		if closeErr != nil {
			return "", closeErr
		}
	}
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if err = root.Rename(stage, final); err != nil {
		return "", err
	}
	directory, err := root.Open(parent)
	if err != nil {
		return "", err
	}
	defer directory.Close()
	if err = directory.Sync(); err != nil {
		return "", err
	}
	return value.Summary, nil
}
