package ws

import (
	"crypto/tls"
	"net/http"
	"strings"
	"time"
)

// AccessToken follows the existing refresh mutex; callers must obtain a fresh
// value per request instead of capturing the startup token.
func (c *Client) AccessToken() string {
	c.tokenMu.Lock()
	defer c.tokenMu.Unlock()
	return c.token
}

// RelayHTTPClient shares the WebSocket's certificate pin callback and ordinary
// CA/hostname validation. SetRelayPin is configured at bootstrap before either
// transport is started. No bearer request may follow a redirect.
func (c *Client) RelayHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if c.relayPin != "" && strings.HasPrefix(c.relayURL, "wss://") {
		transport.TLSClientConfig = &tls.Config{VerifyPeerCertificate: c.verifyPinnedCert}
	}
	return &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func (c *Client) SetTeamDeliveryEnabled(enabled bool) {
	c.agentMu.Lock()
	c.teamDeliveryEnabled = enabled
	c.agentMu.Unlock()
}

func (c *Client) SetTeamStepsEnabled(enabled bool) {
	c.agentMu.Lock()
	c.teamStepsEnabled = enabled
	c.agentMu.Unlock()
}
