package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
