package memorysync

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// GrantSource produces fresh upload grants on demand (test seams inject
// fakes; production wires the HTTP GrantClient).
type GrantSource interface {
	Grant(ctx context.Context, scopeInstallationID string) (Grant, error)
}

// GrantSourceFunc adapts a function into a GrantSource.
type GrantSourceFunc func(ctx context.Context, scopeInstallationID string) (Grant, error)

// Grant implements GrantSource.
func (f GrantSourceFunc) Grant(ctx context.Context, scopeInstallationID string) (Grant, error) {
	return f(ctx, scopeInstallationID)
}

// UploadClient performs the frozen start/upload/finalize sequence against
// the operator-owned Memory origin with bounded retries, grant refresh on
// authorization failure, and redacted server errors.
type UploadClient struct {
	options UploadClientOptions
}

// UploadClientOptions configures retries and grant handling.
type UploadClientOptions struct {
	MemoryOrigin string
	GrantSource  GrantSource
	HTTPClient   *http.Client
	RetryWait    time.Duration
	RetryMax     int
}

// SyncResult is the terminal outcome of one full upload.
type SyncResult struct {
	SnapshotID string
	Repository string
	State      string
}

// NewUploadClient builds the bounded uploader.
func NewUploadClient(options UploadClientOptions) *UploadClient {
	if options.RetryWait <= 0 {
		options.RetryWait = 250 * time.Millisecond
	}
	if options.RetryMax <= 0 {
		options.RetryMax = 3
	}
	if options.HTTPClient == nil {
		options.HTTPClient = &http.Client{Timeout: 60 * time.Second}
	}
	return &UploadClient{options: options}
}

// SyncSnapshot uploads the whole snapshot: start, batched files, finalize.
func (u *UploadClient) SyncSnapshot(ctx context.Context, idempotencyKey string, snapshot *Snapshot) (SyncResult, error) {
	grant, err := u.options.GrantSource.Grant(ctx, "")
	if err != nil {
		return SyncResult{}, fmt.Errorf("grant: %w", err)
	}

	start := StartCodeSnapshotRequest{
		Repository: RepositoryRef{
			RepositoryKey:   snapshot.RepositoryKey,
			CanonicalRemote: snapshot.CanonicalRemote,
		},
		GitObjectFormat:     snapshot.GitObjectFormat,
		CommitSHA:           snapshot.CommitSHA,
		ManifestSHA256:      snapshot.ManifestSHA256,
		ExpectedFileCount:   len(snapshot.Entries),
		ExpectedByteCount:   snapshot.TotalBytes,
		ParserMatrixVersion: snapshot.ParserMatrixVersion,
		IdempotencyKey:      idempotencyKey,
	}
	var startResult StartResult
	if err := u.call(ctx, http.MethodPost, "/api/v1/memory/code-snapshots", idempotencyKey, start, &startResult, &grant); err != nil {
		return SyncResult{}, err
	}

	batches := buildBatches(snapshot.Entries)
	for _, batch := range batches {
		var uploadResult struct {
			Accepted int `json:"accepted"`
		}
		if err := u.call(ctx, http.MethodPut,
			"/api/v1/memory/code-snapshots/"+startResult.SnapshotID+"/files",
			idempotencyKey, batch, &uploadResult, &grant); err != nil {
			return SyncResult{}, err
		}
	}

	finalize := FinalizeCodeSnapshotRequest{
		ManifestSHA256:    snapshot.ManifestSHA256,
		ExpectedFileCount: len(snapshot.Entries),
		ExpectedByteCount: snapshot.TotalBytes,
		IdempotencyKey:    idempotencyKey,
	}
	var finalizeResult FinalizeResult
	if err := u.call(ctx, http.MethodPost,
		"/api/v1/memory/code-snapshots/"+startResult.SnapshotID+"/finalize",
		idempotencyKey, finalize, &finalizeResult, &grant); err != nil {
		return SyncResult{}, err
	}
	return SyncResult{
		SnapshotID: finalizeResult.SnapshotID,
		Repository: startResult.RepositoryID,
		State:      finalizeResult.State,
	}, nil
}

// buildBatches packs entries into requests bounded by MaxRequestBytes on the
// base64-inflated wire size.
func buildBatches(entries []CollectedEntry) []CodeSnapshotFileBatch {
	var batches []CodeSnapshotFileBatch
	var current CodeSnapshotFileBatch
	var currentBytes int64
	flush := func() {
		if len(current.Entries) > 0 {
			batches = append(batches, current)
		}
		current = CodeSnapshotFileBatch{}
		currentBytes = 0
	}
	for _, entry := range entries {
		wire := CodeSnapshotFileEntry{
			Path:          entry.Path,
			GitMode:       entry.GitMode,
			Language:      entry.Language,
			Capability:    entry.Capability,
			BlobSHA256:    entry.BlobSHA256,
			ByteCount:     entry.ByteCount,
			ContentBase64: base64.StdEncoding.EncodeToString(entry.Content),
		}
		entryBytes := int64(len(wire.ContentBase64) + len(wire.Path) + 512)
		if currentBytes+entryBytes > MaxRequestBytes && len(current.Entries) > 0 {
			flush()
		}
		currentBytes += entryBytes
		current.Entries = append(current.Entries, wire)
	}
	flush()
	for i := range batches {
		batches[i].BatchIndex = i
	}
	return batches
}

// call performs one bounded HTTP call with retry, grant refresh, and
// redaction: the error never echoes the response body.
func (u *UploadClient) call(
	ctx context.Context,
	method, path, idempotencyKey string,
	body any,
	out any,
	grant *Grant,
) error {
	backoff := u.options.RetryWait
	var lastErr error
	for attempt := 0; attempt <= u.options.RetryMax; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return fmt.Errorf("canceled")
			}
			backoff *= 2
		}
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		origin := u.options.MemoryOrigin
		if origin == "" {
			origin = grant.Origin
		}
		request, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(origin, "/")+path, bytes.NewReader(encoded))
		if err != nil {
			return err
		}
		request.Header.Set("authorization", "Bearer "+grant.Token)
		request.Header.Set("content-type", "application/json")
		if method == http.MethodPost {
			request.Header.Set("idempotency-key", idempotencyKey)
		}
		response, err := u.options.HTTPClient.Do(request)
		if err != nil {
			lastErr = fmt.Errorf("memory_http_unreachable")
			continue
		}
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		_ = response.Body.Close()
		switch {
		case response.StatusCode >= 200 && response.StatusCode < 300:
			if out == nil {
				return nil
			}
			if len(raw) == 0 {
				return nil
			}
			if err := json.Unmarshal(raw, out); err != nil {
				return fmt.Errorf("invalid_response")
			}
			return nil
		case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
			// One grant refresh per call: re-derive and retry immediately.
			fresh, grantErr := u.options.GrantSource.Grant(ctx, "")
			if grantErr != nil {
				return fmt.Errorf("grant: %w", grantErr)
			}
			*grant = fresh
			lastErr = fmt.Errorf("memory_http_%d", response.StatusCode)
			continue
		case response.StatusCode == http.StatusConflict:
			// Idempotency/integrity mismatch is terminal, not transient.
			return fmt.Errorf("integrity_mismatch")
		case response.StatusCode >= 500:
			lastErr = fmt.Errorf("memory_http_%d", response.StatusCode)
			continue
		default:
			return fmt.Errorf("memory_http_%d", response.StatusCode)
		}
	}
	return lastErr
}
