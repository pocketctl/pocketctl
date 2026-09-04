package memorycontext

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMemoryClientConsumesPackWithAdmissionAndSessionBinding(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/memory/context/packs/pack-1/text" {
			t.Errorf("path = %q", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		query := r.URL.Query()
		if query.Get("session_id") != "ses-1" || query.Get("injection_id") != "inj-1" || query.Get("nonce") != "nonce-1" {
			t.Errorf("missing admission binding: %v", query)
			http.Error(w, "bad binding", http.StatusBadRequest)
			return
		}
		if r.Header.Get("Authorization") != "Bearer grant-1" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(PackText{
			PackID: "pack-1", StableText: "stable", DynamicText: "dynamic",
			StableDigest: "aa", DynamicDigest: "bb",
		})
	}))
	defer server.Close()

	client := NewMemoryClient()
	consumer, ok := client.(interface {
		ConsumePack(context.Context, string, string, string, string, string, string) (*PackText, error)
	})
	if !ok {
		t.Fatal("memory client has no admission-bound pack consume operation")
	}
	pack, err := consumer.ConsumePack(context.Background(), server.URL, "grant-1",
		"pack-1", "ses-1", "inj-1", "nonce-1")
	if err != nil {
		t.Fatalf("consume pack: %v", err)
	}
	if pack.StableText != "stable" || pack.DynamicText != "dynamic" {
		t.Fatalf("pack = %+v", pack)
	}
}
