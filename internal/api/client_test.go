package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestSendEmailCodeIncludesLanguage(t *testing.T) {
	want := map[string]string{"email": "user@example.com", "lang": "zh"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/email/send" {
			t.Errorf("path = %q, want %q", r.URL.Path, "/api/auth/email/send")
		}
		var got map[string]string
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("request body = %#v, want %#v", got, want)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()

	if err := SendEmailCode(server.URL, "user@example.com", "zh"); err != nil {
		t.Fatalf("SendEmailCode() error = %v", err)
	}
}

func TestVerifyEmailCodeIncludesLanguageAndMachineID(t *testing.T) {
	want := map[string]string{"email": "user@example.com", "code": "123456", "lang": "en", "machine_id": "daemon-622f9090"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/email/verify" {
			t.Errorf("path = %q, want %q", r.URL.Path, "/api/auth/email/verify")
		}
		var got map[string]string
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("request body = %#v, want %#v", got, want)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"access","refresh_token":"refresh"}`))
	}))
	defer server.Close()

	accessToken, refreshToken, err := VerifyEmailCode(server.URL, "user@example.com", "123456", "en", "daemon-622f9090")
	if err != nil {
		t.Fatalf("VerifyEmailCode() error = %v", err)
	}
	if accessToken != "access" || refreshToken != "refresh" {
		t.Fatalf("VerifyEmailCode() = (%q, %q), want (%q, %q)", accessToken, refreshToken, "access", "refresh")
	}
}

func TestRefreshTokenIncludesMachineID(t *testing.T) {
	want := map[string]string{"refresh_token": "refresh", "machine_id": "daemon-622f9090"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/refresh" {
			t.Errorf("path = %q, want %q", r.URL.Path, "/api/auth/refresh")
		}
		var got map[string]string
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("request body = %#v, want %#v", got, want)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"access","refresh_token":"next-refresh"}`))
	}))
	defer server.Close()

	accessToken, refreshToken, err := RefreshToken(server.URL, "refresh", "daemon-622f9090")
	if err != nil {
		t.Fatalf("RefreshToken() error = %v", err)
	}
	if accessToken != "access" || refreshToken != "next-refresh" {
		t.Fatalf("RefreshToken() = (%q, %q), want (%q, %q)", accessToken, refreshToken, "access", "next-refresh")
	}
}

func TestParseJWTEmail(t *testing.T) {
	tests := []struct {
		name    string
		token   string
		want    string
		wantErr string
	}{
		{
			name:  "email claim",
			token: "header.eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20ifQ.signature",
			want:  "user@example.com",
		},
		{
			name:    "missing email claim",
			token:   "header.eyJleHAiOjF9.signature",
			wantErr: "no email claim",
		},
		{
			name:    "invalid token",
			token:   "not-a-jwt",
			wantErr: "invalid JWT format",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseJWTEmail(tt.token)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("ParseJWTEmail() error = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("ParseJWTEmail() = (%q, %v), want (%q, nil)", got, err, tt.want)
			}
		})
	}
}
