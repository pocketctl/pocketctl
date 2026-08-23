//go:build darwin

package platform

import (
	"errors"
	"os"
	"testing"
)

func TestProcessStartIdentityDarwinUsesKernelStartTime(t *testing.T) {
	got, err := processStartIdentityDarwin(
		123,
		func(pid int) (darwinProcessStartInfo, error) {
			if pid != 123 {
				t.Fatalf("queried pid=%d", pid)
			}
			return darwinProcessStartInfo{PID: 123, Sec: 1700000000, Usec: 456789}, nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got != "darwin:1700000000:456789" {
		t.Fatalf("identity=%q", got)
	}
}

func TestProcessStartIdentityDarwinRejectsQueryFailureAndPIDMismatch(t *testing.T) {
	if _, err := processStartIdentityDarwin(
		123,
		func(int) (darwinProcessStartInfo, error) {
			return darwinProcessStartInfo{}, os.ErrPermission
		},
	); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("query error=%v", err)
	}
	if _, err := processStartIdentityDarwin(
		123,
		func(int) (darwinProcessStartInfo, error) {
			return darwinProcessStartInfo{PID: 456, Sec: 1700000000}, nil
		},
	); err == nil {
		t.Fatal("PID mismatch was accepted")
	}
}

func TestProcessStartIdentityDarwinReadsCurrentProcessStably(t *testing.T) {
	first, err := ProcessStartIdentity(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	second, err := ProcessStartIdentity(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if first == "" || first != second {
		t.Fatalf("first=%q second=%q", first, second)
	}
}
