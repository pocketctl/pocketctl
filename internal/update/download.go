package update

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/i18n"
)

type downloadPolicy struct {
	Overall, Idle, Attempt, RetryDelay time.Duration
}

// Budget from the official asset size, never the untrusted response header.
func downloadAttemptTimeout(size int64) time.Duration {
	const rate = int64(32 * 1024)
	if size <= 0 {
		return 3 * time.Minute
	}
	if size >= rate*540 {
		return 10 * time.Minute
	}
	budget := time.Minute + time.Duration((size+rate-1)/rate)*time.Second
	if budget < 90*time.Second {
		return 90 * time.Second
	}
	return budget
}

// DownloadAndVerify preserves the existing API for callers without a context.
func DownloadAndVerify(info *BinaryInfo) (string, error) {
	return DownloadAndVerifyContext(context.Background(), info)
}

// DownloadAndVerifyContext bounds all sources and retries while retaining strict
// official size/digest verification. It never installs or restarts anything.
func DownloadAndVerifyContext(ctx context.Context, info *BinaryInfo) (string, error) {
	if info == nil {
		return "", errors.New("missing binary download information")
	}
	return downloadWithPolicy(ctx, info, downloadPolicy{
		Overall: 12 * time.Minute, Idle: 30 * time.Second,
		Attempt: downloadAttemptTimeout(info.Size), RetryDelay: time.Second,
	}, os.Stderr)
}

var errDownloadIdle = errors.New("download made no progress")

// HTTP errors may quote redirect URLs (including credentials and signed
// queries) even after unwrapping url.Error. Log safe categories, never the
// arbitrary transport error string. The source host is reported separately.
func downloadTransportError(err error) error {
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return errors.New("download request timed out")
	}
	var dnsError *net.DNSError
	if errors.As(err, &dnsError) {
		return errors.New("download DNS lookup failed")
	}
	var connectionError *net.OpError
	if errors.As(err, &connectionError) {
		return errors.New("download connection failed")
	}
	return errors.New("download request failed (network, TLS, or redirect error)")
}

func downloadWithPolicy(ctx context.Context, info *BinaryInfo, policy downloadPolicy, out io.Writer) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, policy.Overall)
	defer cancel()
	urls := append([]string{info.URL}, info.FallbackURLs...)
	var failures []error
	for index, rawURL := range urls {
		if ctx.Err() != nil {
			return "", errors.Join(append(failures, ctx.Err())...)
		}
		label := downloadSourceLabel(rawURL)
		if index > 0 {
			fmt.Fprintln(out, i18n.T("update.source_switch", label))
		}
		for attempt := 1; attempt <= maxDownloadRetries; attempt++ {
			if attempt > 1 {
				timer := time.NewTimer(time.Duration(attempt-1) * policy.RetryDelay)
				select {
				case <-ctx.Done():
					timer.Stop()
					return "", errors.Join(append(failures, ctx.Err())...)
				case <-timer.C:
				}
			}
			fmt.Fprintln(out, i18n.T("update.source_attempt", label, index+1, len(urls), attempt, maxDownloadRetries))
			path, retry, err := downloadAttempt(ctx, rawURL, info, policy, out)
			if err == nil {
				return path, nil
			}
			failure := fmt.Errorf("%s (%d/%d): %w", label, attempt, maxDownloadRetries, err)
			failures = append(failures, failure)
			fmt.Fprintln(out, i18n.T("update.source_failed", label, err))
			if ctx.Err() != nil {
				return "", errors.Join(append(failures, ctx.Err())...)
			}
			if !retry {
				break
			}
		}
	}
	return "", fmt.Errorf("%s: %w", i18n.T("update.network_hint"), errors.Join(failures...))
}

func downloadSourceLabel(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		return "download source"
	}
	return parsed.Host // Do not log userinfo, query strings, or signed paths.
}

func downloadAttempt(ctx context.Context, rawURL string, info *BinaryInfo, policy downloadPolicy, out io.Writer) (path string, retry bool, err error) {
	deadlineCtx, deadlineCancel := context.WithTimeout(ctx, policy.Attempt)
	defer deadlineCancel()
	requestCtx, cancel := context.WithCancelCause(deadlineCtx)
	defer cancel(nil)
	idle := time.AfterFunc(policy.Idle, func() { cancel(errDownloadIdle) })
	defer idle.Stop()
	file, err := os.CreateTemp("", "pocketctl-update-*")
	if err != nil {
		return "", false, fmt.Errorf("create temp file: %w", err)
	}
	path = file.Name()
	defer func() {
		file.Close()
		if err != nil {
			os.Remove(path)
		}
	}()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, rawURL, nil)
	if err != nil {
		return path, false, errors.New("invalid download URL")
	}
	resp, err := downloadClient.Do(req)
	if err != nil {
		if cause := context.Cause(requestCtx); cause != nil {
			return path, false, cause
		}
		return path, true, downloadTransportError(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return path, resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusGone, fmt.Errorf("HTTP %d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
	}
	bar := newProgressBar(resp.ContentLength)
	bar.out = out
	var reader io.Reader = &progressReader{r: resp.Body, bar: bar, onProgress: func() { idle.Reset(policy.Idle) }}
	if info.Size > 0 && info.Size < int64(^uint64(0)>>1) {
		reader = io.LimitReader(reader, info.Size+1)
	}
	written, copyErr := io.Copy(file, reader)
	idle.Stop()
	bar.Finish(copyErr)
	if cause := context.Cause(requestCtx); cause != nil {
		return path, false, cause
	}
	if copyErr != nil {
		return path, true, fmt.Errorf("read response: %w", copyErr)
	}
	if err = file.Close(); err != nil {
		return path, false, err
	}
	if written == 0 {
		return path, true, errors.New("downloaded file is empty")
	}
	if info.Size > 0 && written != info.Size {
		return path, false, fmt.Errorf("size mismatch: official %d bytes, got %d", info.Size, written)
	}
	if info.SHA == "" {
		return path, false, errors.New("no official checksum available")
	}
	fmt.Fprintln(out, i18n.T("update.source_verifying", downloadSourceLabel(rawURL)))
	actual, err := fileSHA256(path)
	if err != nil {
		return path, false, fmt.Errorf("compute SHA256: %w", err)
	}
	if !strings.EqualFold(actual, info.SHA) {
		return path, false, fmt.Errorf("SHA256 mismatch: expected %s, got %s", info.SHA, actual)
	}
	if err = os.Chmod(path, 0755); err != nil {
		return path, false, err
	}
	return path, false, nil
}
