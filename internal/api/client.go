package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// SendSMS requests a verification code for the given phone number.
func SendSMS(baseURL, phone string) error {
	resp, err := postJSON(baseURL+"/api/auth/sms/send", map[string]string{"phone": phone})
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

// VerifySMS verifies the SMS code and returns access/refresh tokens.
func VerifySMS(baseURL, phone, code string) (accessToken, refreshToken string, err error) {
	resp, err := postJSON(baseURL+"/api/auth/sms/verify", map[string]string{"phone": phone, "code": code})
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

// HealthCheck sends a GET request to the relay's /health endpoint.
// Returns the response body string or an error.
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

// ParseJWTExpiry parses the exp claim from a JWT token without verifying the signature.
// Returns the expiry time or an error if the token is malformed.
func ParseJWTExpiry(tokenStr string) (time.Time, error) {
	parts := strings.Split(tokenStr, ".")
	if len(parts) != 3 {
		return time.Time{}, fmt.Errorf("invalid JWT format")
	}
	// Decode the payload (second part)
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, fmt.Errorf("decode payload: %w", err)
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

// postJSON sends a POST request with a JSON body and returns the parsed response.
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
