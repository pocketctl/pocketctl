package memorycontext

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// MemoryClient talks to the operator-owned Memory origin with the minted
// session-bound grant. Requests never include the raw original user input
// and responses never include scores or evidence excerpts.
type MemoryClient interface {
	Compile(ctx context.Context, origin, grant string, req CompileRequest) (*CompileResponse, error)
	ConsumePack(ctx context.Context, origin, grant, packID, sessionID, injectionID, nonce string) (*PackText, error)
	Admit(ctx context.Context, origin, grant, packID string, req AdmitRequest) (*AdmitResponse, error)
	Receipt(ctx context.Context, origin, grant, injectionID string, req ReceiptRequest) error
}

// PackText is the enabled-path pack payload for one delivery attempt.
type PackText struct {
	PackID        string `json:"pack_id"`
	StableText    string `json:"stable_text"`
	DynamicText   string `json:"dynamic_text"`
	StableDigest  string `json:"stable_hash"`
	DynamicDigest string `json:"dynamic_hash"`
}

type httpClient struct {
	HTTP *http.Client
}

// NewMemoryClient builds the production HTTP client with bounded timeouts.
func NewMemoryClient() MemoryClient {
	return &httpClient{HTTP: &http.Client{Timeout: 3 * time.Second}}
}

func (c *httpClient) do(ctx context.Context, method, url, grant string, body any, out any) error {
	var reader *bytes.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	} else {
		reader = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+grant)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		// Bounded error: status class only, never the body.
		return fmt.Errorf("memory api status %d", resp.StatusCode)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *httpClient) Compile(ctx context.Context, origin, grant string, req CompileRequest) (*CompileResponse, error) {
	var out CompileResponse
	if err := c.do(ctx, http.MethodPost, origin+"/api/v1/memory/context/compile", grant, req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *httpClient) ConsumePack(ctx context.Context, origin, grant, packID, sessionID, injectionID, nonce string) (*PackText, error) {
	var out PackText
	query := url.Values{}
	query.Set("session_id", sessionID)
	query.Set("injection_id", injectionID)
	query.Set("nonce", nonce)
	endpoint := origin + "/api/v1/memory/context/packs/" + url.PathEscape(packID) + "/text?" + query.Encode()
	if err := c.do(ctx, http.MethodGet, endpoint, grant, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *httpClient) Admit(ctx context.Context, origin, grant, packID string, req AdmitRequest) (*AdmitResponse, error) {
	var out AdmitResponse
	if err := c.do(ctx, http.MethodPost, origin+"/api/v1/memory/context/packs/"+packID+"/admit", grant, req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *httpClient) Receipt(ctx context.Context, origin, grant, injectionID string, req ReceiptRequest) error {
	return c.do(ctx, http.MethodPost, origin+"/api/v1/memory/context/injections/"+injectionID+"/receipt", grant, req, nil)
}
