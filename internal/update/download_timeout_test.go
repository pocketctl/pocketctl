package update

import (
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func shortDownloadPolicy() downloadPolicy {
	return downloadPolicy{Overall: 2 * time.Second, Idle: 80 * time.Millisecond, Attempt: time.Second, RetryDelay: time.Millisecond}
}

func TestDownloadAttemptBudgetUsesOfficialSize(t *testing.T) {
	if got := downloadAttemptTimeout(16 * 1024 * 1024); got <= 3*time.Minute {
		t.Fatalf("slow 16 MiB download still limited to %s", got)
	}
	if got := downloadAttemptTimeout(0); got != 3*time.Minute {
		t.Fatalf("unknown-size budget=%s", got)
	}
	if got := downloadAttemptTimeout(math.MaxInt64); got != 10*time.Minute {
		t.Fatalf("large-size budget overflowed: %s", got)
	}
}

func TestDownloadRotatesStalledSourceWithoutRepeatingIt(t *testing.T) {
	for _, bodyStall := range []bool{false, true} {
		t.Run(strconv.FormatBool(bodyStall), func(t *testing.T) {
			var calls atomic.Int32
			stalled := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if bodyStall {
					w.Header().Set("Content-Length", "100")
					w.Write([]byte("x"))
					w.(http.Flusher).Flush()
				}
				<-r.Context().Done()
			}))
			defer stalled.Close()
			good := []byte("official")
			safe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(good) }))
			defer safe.Close()
			tmp := t.TempDir()
			t.Setenv("TMPDIR", tmp)
			t.Setenv("TMP", tmp)
			t.Setenv("TEMP", tmp)
			path, err := downloadWithPolicy(context.Background(), &BinaryInfo{URL: stalled.URL, FallbackURLs: []string{safe.URL}, SHA: hexSHA(good)}, shortDownloadPolicy(), io.Discard)
			if err != nil {
				t.Fatal(err)
			}
			defer os.Remove(path)
			if calls.Load() != 1 {
				t.Fatalf("repeated stalled source %d times", calls.Load())
			}
			files, _ := os.ReadDir(tmp)
			if len(files) != 1 {
				t.Fatalf("failed download left temporary files: %v", files)
			}
		})
	}
}

func TestDownloadAllowsSlowTransferWithContinuousProgress(t *testing.T) {
	data := []byte(strings.Repeat("a", 8))
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		for _, b := range data {
			w.Write([]byte{b})
			w.(http.Flusher).Flush()
			time.Sleep(30 * time.Millisecond)
		}
	}))
	defer s.Close()
	path, err := downloadWithPolicy(context.Background(), &BinaryInfo{URL: s.URL, SHA: hexSHA(data), Size: int64(len(data))}, shortDownloadPolicy(), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	got, _ := os.ReadFile(path)
	if string(got) != string(data) {
		t.Fatalf("wrong bytes: %q", got)
	}
}

func TestDownloadOverallDeadlineStopsEvenWhileBytesArrive(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(10 * time.Millisecond):
				w.Write([]byte("x"))
				w.(http.Flusher).Flush()
			}
		}
	}))
	defer s.Close()
	policy := shortDownloadPolicy()
	policy.Overall = 90 * time.Millisecond
	_, err := downloadWithPolicy(context.Background(), &BinaryInfo{URL: s.URL, SHA: hexSHA([]byte("x"))}, policy, io.Discard)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("overall deadline lost: %v", err)
	}
}

func TestDownloadCancellationInterruptsRetryBackoff(t *testing.T) {
	var calls atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(503) }))
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	policy := shortDownloadPolicy()
	policy.RetryDelay = 5 * time.Second
	start := time.Now()
	_, err := downloadWithPolicy(ctx, &BinaryInfo{URL: s.URL, SHA: hexSHA([]byte("x"))}, policy, io.Discard)
	if !errors.Is(err, context.DeadlineExceeded) || calls.Load() != 1 || time.Since(start) > time.Second {
		t.Fatalf("backoff ignored cancellation: calls=%d elapsed=%s err=%v", calls.Load(), time.Since(start), err)
	}
}
