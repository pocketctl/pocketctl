package main

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/pocketctl/pocketctl/internal/api"
	"github.com/pocketctl/pocketctl/internal/ws"
)

func TestDaemonRefreshFailureCategoriesAndDurableSave(t *testing.T) {
	temporary := errors.New("temporary transport failure")
	for _, tc := range []struct {
		name                               string
		loadErr, refreshErr, saveErr, want error
		missing                            bool
		refreshes, saves                   int
	}{
		{name: "missing file", loadErr: os.ErrNotExist, want: ws.ErrRefreshLoginRequired},
		{name: "unreadable file", loadErr: os.ErrPermission, want: ws.ErrRefreshStorageUnavailable},
		{name: "malformed file", loadErr: errors.New("invalid JSON"), want: ws.ErrRefreshStorageUnavailable},
		{name: "missing refresh", missing: true, want: ws.ErrRefreshLoginRequired},
		{name: "rejected refresh", refreshErr: api.ErrRefreshRejected, want: ws.ErrRefreshLoginRequired, refreshes: 1},
		{name: "temporary failure", refreshErr: temporary, want: temporary, refreshes: 1},
		{name: "failed save", saveErr: os.ErrPermission, want: ws.ErrRefreshPersistenceFailed, refreshes: 1, saves: 3},
		{name: "success", refreshes: 1, saves: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			refreshes, saves := 0, 0
			token, err := refreshDaemonToken(context.Background(), "machine",
				func() (string, string, string, error) {
					rt := "old-refresh"
					if tc.missing {
						rt = ""
					}
					return "wss://relay.example/ws", "old-access", rt, tc.loadErr
				},
				func(_ context.Context, url, rt, machine string) (string, string, error) {
					refreshes++
					if url != "https://relay.example" || rt != "old-refresh" || machine != "machine" {
						t.Fatalf("wrong refresh request")
					}
					return "new-access", "new-refresh", tc.refreshErr
				},
				func(url, at, rt string) error {
					saves++
					if url != "wss://relay.example/ws" || at != "new-access" || rt != "new-refresh" {
						t.Fatal("did not persist rotated pair")
					}
					return tc.saveErr
				},
			)
			if !errors.Is(err, tc.want) {
				t.Fatalf("error=%v want=%v", err, tc.want)
			}
			if tc.want == nil && token != "new-access" {
				t.Fatalf("token=%q", token)
			}
			if tc.want != nil && token != "" {
				t.Fatal("released unpersisted/invalid credential")
			}
			if refreshes != tc.refreshes || saves != tc.saves {
				t.Fatalf("refresh=%d save=%d", refreshes, saves)
			}
		})
	}
}

func TestDaemonRefreshPersistsRotatedPairDuringShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	saved := false
	_, err := refreshDaemonToken(ctx, "machine",
		func() (string, string, string, error) { return "wss://relay/ws", "old", "refresh", nil },
		func(context.Context, string, string, string) (string, string, error) {
			cancel()
			return "new", "rotated", nil
		},
		func(_ string, access, refresh string) error {
			saved = access == "new" && refresh == "rotated"
			return nil
		},
	)
	if err != nil || !saved {
		t.Fatalf("successful rotation lost during shutdown: saved=%v err=%v", saved, err)
	}
}
