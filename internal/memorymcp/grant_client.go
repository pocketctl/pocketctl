package memorymcp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"
)

// GrantSource produces fresh grants. Implementations: IPCGrantSource (bridge
// process -> daemon socket) and test fakes.
type GrantSource interface {
	Grant(ctx context.Context, scopeInstallationIDs []string) (Grant, error)
}

// IPCGrantSource asks the daemon over the user-private memory-mcp socket.
type IPCGrantSource struct {
	SocketPath string
	Dial       func(ctx context.Context, path string) (net.Conn, error)
}

// Grant performs one request/response exchange on a fresh connection.
func (s *IPCGrantSource) Grant(ctx context.Context, scopeInstallationIDs []string) (Grant, error) {
	dial := s.Dial
	if dial == nil {
		dial = dialUnix
	}
	conn, err := dial(ctx, s.SocketPath)
	if err != nil {
		return Grant{}, fmt.Errorf("memory-mcp socket: %w", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	request, err := json.Marshal(IpcGrantRequest{
		Type: "memory_mcp_grant_request", ScopeInstallationIDs: scopeInstallationIDs,
	})
	if err != nil {
		return Grant{}, err
	}
	if _, err := conn.Write(append(request, '\n')); err != nil {
		return Grant{}, err
	}
	line, err := readIPCLine(conn)
	if err != nil {
		return Grant{}, err
	}
	var response IpcGrantResponse
	if err := json.Unmarshal(line, &response); err != nil {
		return Grant{}, err
	}
	if response.Error != "" {
		return Grant{}, errors.New(response.Error)
	}
	if response.Grant == "" {
		return Grant{}, errors.New("empty_grant")
	}
	return Grant{
		Token:     response.Grant,
		ExpiresAt: response.ExpiresAt,
		Origin:    response.ProviderPublicOrigin,
		InstallID: response.InstallationID,
	}, nil
}

const maxIPCFrameBytes = 4096

func readIPCLine(reader io.Reader) ([]byte, error) {
	line, err := bufio.NewReader(io.LimitReader(reader, maxIPCFrameBytes+1)).ReadBytes('\n')
	if len(line) > maxIPCFrameBytes {
		return nil, errors.New("ipc_frame_too_large")
	}
	if err != nil {
		return nil, err
	}
	return line, nil
}

// RefreshLead is how long before expiry a cached grant refreshes.
const RefreshLead = 30 * time.Second

// CachingGrantSource caches one grant in memory and refreshes it whenever
// less than RefreshLead remains. Safe for concurrent use.
type CachingGrantSource struct {
	Inner GrantSource
	Now   func() time.Time

	mu     sync.Mutex
	cached map[string]Grant
}

// Token returns a grant with more than RefreshLead of validity left.
func (c *CachingGrantSource) Token(ctx context.Context, scopeInstallationIDs []string) (Grant, error) {
	cacheKey := strings.Join(scopeInstallationIDs, "\x00")
	c.mu.Lock()
	cached := c.cached[cacheKey]
	c.mu.Unlock()
	now := c.Now
	if now == nil {
		now = time.Now
	}
	if cached.Token != "" && cached.Remaining(now()) > RefreshLead {
		return cached, nil
	}
	fresh, err := c.Inner.Grant(ctx, scopeInstallationIDs)
	if err != nil {
		return Grant{}, err
	}
	if fresh.ExpiresAt.IsZero() {
		// No expiry supplied: usable once, immediately stale afterwards.
		fresh.ExpiresAt = now().Add(2 * time.Second)
	}
	c.mu.Lock()
	if c.cached == nil {
		c.cached = make(map[string]Grant)
	}
	c.cached[cacheKey] = fresh
	c.mu.Unlock()
	return fresh, nil
}

// Invalidate forgets token when it is still the cached value. A concurrent
// refresh is never erased by a stale caller.
func (c *CachingGrantSource) Invalidate(token string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, grant := range c.cached {
		if grant.Token == token {
			delete(c.cached, key)
		}
	}
}

// dialUnix dials a unix domain socket with a context deadline.
func dialUnix(ctx context.Context, path string) (net.Conn, error) {
	d := net.Dialer{Timeout: 3 * time.Second}
	return d.DialContext(ctx, "unix", path)
}
