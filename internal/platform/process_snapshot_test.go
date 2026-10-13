package platform

import (
	"context"
	"os"
	"testing"
)

func TestInspectProcessReadsOnlyTarget(t *testing.T) {
	snapshot, err := InspectProcess(context.Background(), os.Getpid())
	if err != nil || snapshot.PID != os.Getpid() || snapshot.Executable == "" || len(snapshot.Args) == 0 {
		t.Fatalf("snapshot=%+v err=%v", snapshot, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := InspectProcess(ctx, os.Getpid()); err != context.Canceled {
		t.Fatalf("cancellation=%v", err)
	}
	if _, err := InspectProcess(context.Background(), -1); err == nil {
		t.Fatal("accepted invalid PID")
	}
}
