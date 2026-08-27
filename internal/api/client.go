package api

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ---- PKCE Utilities ----

// GenerateCodeVerifier creates a cryptographically random code verifier
// per RFC 7636. Returns 32 random bytes encoded as base64url (43 chars).
func GenerateCodeVerifier() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate code verifier: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// ComputeCodeChallenge computes the S256 code challenge from a code verifier.
// Returns the SHA256 hash of the verifier, base64url-encoded.
func ComputeCodeChallenge(verifier string) string {
	h := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

// ---- OAuth 2.0 Device Authorization Grant ----

// DeviceAuthResponse is the response from POST /api/auth/device/authorize.
type DeviceAuthResponse struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

// DeviceTokenResponse is the response from POST /api/auth/device/token.
type DeviceTokenResponse struct {
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token"`
	TokenType        string `json:"token_type"`
	ExpiresIn        int    `json:"expires_in"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

// DeviceAuthorize sends a device authorization request per RFC 8628 §3.1.
func DeviceAuthorize(baseURL, clientID, codeChallenge, machineID string) (*DeviceAuthResponse, error) {
	body := map[string]string{
		"client_id":             clientID,
		"code_challenge":        codeChallenge,
		"code_challenge_method": "S256",
	}
	if machineID != "" {
		body["machine_id"] = machineID
	}

	resp, err := postJSON(baseURL+"/api/auth/device/authorize", body)
	if err != nil {
		return nil, err
	}
	if errMsg, ok := resp["error"].(string); ok {
		desc, _ := resp["error_description"].(string)
		return nil, fmt.Errorf("%s: %s", errMsg, desc)
	}
	return &DeviceAuthResponse{
		DeviceCode:              stringField(resp, "device_code"),
		UserCode:                stringField(resp, "user_code"),
		VerificationURI:         stringField(resp, "verification_uri"),
		VerificationURIComplete: stringField(resp, "verification_uri_complete"),
		ExpiresIn:               intField(resp, "expires_in"),
		Interval:                intField(resp, "interval"),
	}, nil
}

// DeviceToken polls the token endpoint for an access token per RFC 8628 §3.4.
func DeviceToken(baseURL, deviceCode, clientID, codeVerifier string) (*DeviceTokenResponse, error) {
	body := map[string]string{
		"grant_type":    "urn:ietf:params:oauth:grant-type:device_code",
		"device_code":   deviceCode,
		"client_id":     clientID,
		"code_verifier": codeVerifier,
	}

	resp, err := postJSON(baseURL+"/api/auth/device/token", body)
	if err != nil {
		return nil, err
	}

	result := &DeviceTokenResponse{
		AccessToken:      stringField(resp, "access_token"),
		RefreshToken:     stringField(resp, "refresh_token"),
		TokenType:        stringField(resp, "token_type"),
		ExpiresIn:        intField(resp, "expires_in"),
		Error:            stringField(resp, "error"),
		ErrorDescription: stringField(resp, "error_description"),
	}
	return result, nil
}

// ---- Token Revocation ----

// RevokeToken revokes an access or refresh token per RFC 7009 semantics.
func RevokeToken(baseURL, token, tokenTypeHint string) error {
	body := map[string]string{"token": token}
	if tokenTypeHint != "" {
		body["token_type_hint"] = tokenTypeHint
	}
	_, err := postJSON(baseURL+"/api/auth/revoke", body)
	return err
}

// ---- Email Verification Code Auth ----

// SendEmailCode requests a verification code for the given email address.
func SendEmailCode(baseURL, email, lang string) error {
	resp, err := postJSON(baseURL+"/api/auth/email/send", map[string]string{"email": email, "lang": lang})
	if err != nil {
		return err
	}
	if resp["success"] == true {
		return nil
	}
	if msg, ok := resp["error"].(string); ok {
		return fmt.Errorf("%s", msg)
	}
	return fmt.Errorf("unexpected response")
}

// VerifyEmailCode verifies the email code and returns access/refresh tokens.
func VerifyEmailCode(baseURL, email, code, lang string) (accessToken, refreshToken string, err error) {
	resp, err := postJSON(baseURL+"/api/auth/email/verify", map[string]string{"email": email, "code": code, "lang": lang})
	if err != nil {
		return "", "", err
	}
	at, _ := resp["access_token"].(string)
	rt, _ := resp["refresh_token"].(string)
	if at == "" {
		if msg, ok := resp["error"].(string); ok {
			return "", "", fmt.Errorf("%s", msg)
		}
		return "", "", fmt.Errorf("verification failed")
	}
	return at, rt, nil
}

// ---- Token Management ----

// RefreshToken refreshes an access token using a refresh token.
func RefreshToken(baseURL, refreshToken string) (accessToken, newRefreshToken string, err error) {
	resp, err := postJSON(baseURL+"/api/auth/refresh", map[string]string{"refresh_token": refreshToken})
	if err != nil {
		return "", "", err
	}
	at, _ := resp["access_token"].(string)
	rt, _ := resp["refresh_token"].(string)
	if at == "" {
		if msg, ok := resp["error"].(string); ok {
			return "", "", fmt.Errorf("%s", msg)
		}
		return "", "", fmt.Errorf("refresh failed")
	}
	return at, rt, nil
}

// ---- Health Check ----

// HealthCheck sends a GET request to the relay's /health endpoint.
func HealthCheck(baseURL string) (string, error) {
	resp, err := http.Get(baseURL + "/health")
	if err != nil {
		return "", fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode >= 400 {
		return string(data), fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return string(data), nil
}

// ---- JWT Utilities ----

// ParseJWTExpiry parses the exp claim from a JWT token without verifying the signature.
func ParseJWTExpiry(tokenStr string) (time.Time, error) {
	payload, err := jwtPayload(tokenStr)
	if err != nil {
		return time.Time{}, err
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return time.Time{}, fmt.Errorf("parse claims: %w", err)
	}
	if claims.Exp == 0 {
		return time.Time{}, fmt.Errorf("no exp claim in token")
	}
	return time.Unix(claims.Exp, 0), nil
}

// ParseJWTEmail returns the authenticated account email embedded in a JWT.
// Like ParseJWTExpiry, it only decodes the locally held token; the relay
// remains authoritative for token signature validation and account identity.
func ParseJWTEmail(tokenStr string) (string, error) {
	payload, err := jwtPayload(tokenStr)
	if err != nil {
		return "", err
	}
	var claims struct {
		Email string `json:"email"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return "", fmt.Errorf("parse claims: %w", err)
	}
	if claims.Email == "" {
		return "", fmt.Errorf("no email claim in token")
	}
	return claims.Email, nil
}

func jwtPayload(tokenStr string) ([]byte, error) {
	parts := strings.Split(tokenStr, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("invalid JWT format")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("decode payload: %w", err)
	}
	return payload, nil
}

// ---- Helpers ----

func postJSON(url string, body map[string]string) (map[string]any, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal body: %w", err)
	}
	req, err := http.NewRequest("POST", url, bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}

	if resp.StatusCode >= 400 {
		if msg, ok := result["error"].(string); ok {
			return result, fmt.Errorf("%s", msg)
		}
		return result, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	return result, nil
}

func stringField(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func intField(m map[string]any, key string) int {
	switch v := m[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	}
	return 0
}
