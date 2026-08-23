package agentcontrol

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

func TestAgentControlClientCapsOnlyDialTime(t *testing.T) {
	client := NewClient("unused")
	client.Dial = func(ctx context.Context, _ string) (net.Conn, error) {
		select {
		case <-time.After(750 * time.Millisecond):
			return nil, errors.New("late dial")
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	started := time.Now()
	_, err := client.Status(ctx, StatusPayload{})
	if err == nil {
		t.Fatal("slow dial unexpectedly succeeded")
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("dial was not capped independently of the request deadline: %v", elapsed)
	}
}
