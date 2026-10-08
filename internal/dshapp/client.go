// Package dshapp attaches to an existing DeepSeek Harness Web Host. It never
// starts another runtime or acquires a session's persistence writer lock.
package dshapp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

type Config struct {
	URL string `json:"url"`
}

func ConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pocketctl", "dsh.json")
}

func LoadConfig() (Config, error) {
	if value := os.Getenv("POCKETCTL_DSH_URL"); value != "" {
		return Config{URL: value}, nil
	}
	data, err := os.ReadFile(ConfigPath())
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	err = json.Unmarshal(data, &cfg)
	return cfg, err
}

func SaveConfig(cfg Config) error {
	if _, err := ValidateURL(cfg.URL); err != nil {
		return err
	}
	path := ConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".dsh-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	data, _ := json.Marshal(cfg)
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

// Native host credentials must never be sent to a remote or redirected host.
func ValidateURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid DSH Host URL")
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme != "http" || u.User != nil || ip == nil || !ip.IsLoopback() || (u.Path != "" && u.Path != "/") || u.Fragment != "" {
		return nil, fmt.Errorf("DSH Host URL must be an http loopback IP root URL (for example http://127.0.0.1:3000/?token=…)")
	}
	return u, nil
}

type Client struct {
	origin string
	http   *http.Client
	u      *url.URL
}

func Connect(ctx context.Context, cfg Config) (*Client, error) {
	u, err := ValidateURL(cfg.URL)
	if err != nil {
		return nil, err
	}
	jar, _ := cookiejar.New(nil)
	h := &http.Client{Jar: jar, Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Transport: &http.Transport{Proxy: nil}}
	req, _ := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	resp, err := h.Do(req)
	if err != nil {
		return nil, fmt.Errorf("DSH Host unavailable")
	} // URL contains a bearer credential.
	resp.Body.Close()
	u.RawQuery = ""
	c := &Client{origin: u.Scheme + "://" + u.Host, http: h, u: u}
	var catalog any
	if err := c.Call(ctx, "session/modelCatalog", map[string]any{}, &catalog); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Client) Close() { c.http.CloseIdleConnections() }

// RPCError is a definitive native rejection. Transport or malformed-response
// errors carry no proof that a mutating operation was rejected.
type RPCError struct{ Method, Code, Message string }

func (e *RPCError) Error() string { return fmt.Sprintf("DSH %s: %s: %s", e.Method, e.Code, e.Message) }

func (c *Client) Call(ctx context.Context, method string, args, result any) error {
	body, err := json.Marshal(map[string]any{"type": "client-request", "rpcId": uuid.NewString(), "method": method, "payload": map[string]any{"args": args}})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.origin+"/api/"+method, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Origin", c.origin)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("DSH %s transport failed", method)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("DSH %s: HTTP %d", method, resp.StatusCode)
	}
	var envelope struct {
		Result struct {
			OK    *bool           `json:"ok"`
			Value json.RawMessage `json:"value"`
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		} `json:"result"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(&envelope); err != nil {
		return fmt.Errorf("invalid DSH %s response", method)
	}
	if envelope.Result.OK == nil {
		return fmt.Errorf("invalid DSH %s response", method)
	}
	if !*envelope.Result.OK {
		return &RPCError{method, envelope.Result.Error.Code, envelope.Result.Error.Message}
	}
	if result != nil {
		return json.Unmarshal(envelope.Result.Value, result)
	}
	return nil
}

func (c *Client) Mux(ctx context.Context) (*websocket.Conn, error) {
	headers := http.Header{"Origin": []string{c.origin}}
	var cookies []string
	for _, cookie := range c.http.Jar.Cookies(c.u) {
		cookies = append(cookies, cookie.String())
	}
	headers.Set("Cookie", strings.Join(cookies, "; "))
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	ws, resp, err := dialer.DialContext(ctx, "ws"+strings.TrimPrefix(c.origin, "http")+"/api/remote.mux", headers)
	if resp != nil && resp.Body != nil {
		resp.Body.Close()
	}
	if err != nil {
		return nil, fmt.Errorf("DSH event connection failed")
	}
	ws.SetReadLimit(32 << 20)
	return ws, nil
}

func Open(ws *websocket.Conn, id, endpoint string, args any) error {
	return ws.WriteJSON(map[string]any{"type": "open", "streamId": id, "endpoint": endpoint, "payload": map[string]any{"args": args}})
}

func Request(value any) map[string]any { return map[string]any{"request": value} }
