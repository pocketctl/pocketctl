package ws

import (
	"context"
	"encoding/json"
	"maps"
	"reflect"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pocketctl/pocketctl/internal/discovery"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// SetAgentInventory atomically replaces types AND metadata. Missing entries are
// removed, while locally refreshed entries preserve the last registry lookup.
func (c *Client) SetAgentInventory(inventory []discovery.AgentInfo) bool {
	c.agentMu.Lock()
	defer c.agentMu.Unlock()
	types := make([]string, 0, len(inventory))
	versions, latest := map[string]string{}, map[string]string{}
	manageable := map[string]bool{}
	dshReady := false
	for _, a := range inventory {
		types = append(types, a.Type)
		if a.Version != "" {
			versions[a.Type] = a.Version
		}
		newest := a.Latest
		if newest == "" {
			newest = c.agentLatests[a.Type]
		}
		if newest != "" {
			latest[a.Type] = newest
		}
		manageable[a.Type] = a.Manageable
		if a.Type == "dsh" {
			dshReady = a.TeamCallable
		}
	}
	changed := !reflect.DeepEqual(types, c.agents) || !maps.Equal(versions, c.agentVersions) || !maps.Equal(latest, c.agentLatests) || !maps.Equal(manageable, c.agentManageable) || dshReady != c.dshTeamCallable
	c.agents, c.agentVersions, c.agentLatests, c.agentManageable, c.dshTeamCallable = types, versions, latest, manageable, dshReady
	return changed
}

func (c *Client) agentRegisterMessage() protocol.RegisterMessage {
	c.agentMu.RLock()
	defer c.agentMu.RUnlock()
	capabilities := []string{protocol.CapabilityTeamDispatchV1, protocol.CapabilityTeamContextV1, protocol.CapabilityTeamReconcileV1, protocol.CapabilityTeamPrivateInteractionsV2}
	if c.teamDeliveryEnabled {
		capabilities = append(capabilities, protocol.CapabilityTeamDeliveryV1)
		if c.teamStepsEnabled {
			capabilities = append(capabilities, protocol.CapabilityTeamStepsV1)
		}
	}
	if c.dshTeamCallable {
		capabilities = append(capabilities, protocol.CapabilityTeamDSHV1)
	}
	agents := append([]string(nil), c.agents...)
	manageable := maps.Clone(c.agentManageable)
	if c.agentTeamsEnabled {
		found := false
		for _, agent := range agents {
			if agent == "agentteams" {
				found = true
			}
		}
		if !found {
			agents = append(agents, "agentteams")
		}
		if manageable == nil {
			manageable = map[string]bool{}
		}
		manageable["agentteams"] = true
		capabilities = append(capabilities, "team_external_agentteams_v1")
		if c.agentTeamsStepsEnabled && c.teamStepsEnabled {
			capabilities = append(capabilities, "team_external_agentteams_steps_v1")
		}
	}
	return protocol.RegisterMessage{
		Type: "register", DaemonID: c.daemonID, Hostname: c.hostname,
		Agents: agents, AgentVersions: maps.Clone(c.agentVersions),
		AgentLatests: maps.Clone(c.agentLatests), AgentManageable: manageable,
		OS: c.osName, IP: c.localIP, Arch: c.arch, Version: c.version, StartedAt: c.startedAt,
		SupportsQuotaGrant: true, SupportsDirectoryBrowse: true, SupportsDocumentResolve: true, Capabilities: capabilities,
	}
}

func (c *Client) SetAgentTeamsEnabled(enabled bool) {
	c.agentMu.Lock()
	c.agentTeamsEnabled = enabled
	c.agentMu.Unlock()
}

func (c *Client) SetAgentTeamsStepsEnabled(enabled bool) {
	c.agentMu.Lock()
	c.agentTeamsStepsEnabled = enabled
	c.agentMu.Unlock()
}

// ResendRegister coalesces inventory changes for the current connection. The
// worker only starts after admission, so a refresh cannot race the handshake.
func (c *Client) ResendRegister() {
	c.connMu.Lock()
	defer c.connMu.Unlock()
	select {
	case c.inventoryRefresh <- struct{}{}:
	default:
	}
}

// Registration always carries the current durable watermark and session routes.
func (c *Client) sendRegistration(ctx context.Context, conn *websocket.Conn, register protocol.RegisterMessage) error {
	if c.activeSessionIDsFn != nil {
		register.ActiveSessionIDs = c.activeSessionIDsFn()
	}
	c.outMu.Lock()
	register.AckedSeq = c.ackedSeq
	c.outMu.Unlock()
	data, err := json.Marshal(register)
	if err != nil {
		return err
	}
	return c.writeMessageTo(ctx, conn, data)
}

func (c *Client) refreshRegistration(ctx context.Context, conn *websocket.Conn, requests <-chan struct{}, last protocol.RegisterMessage, retryDelay time.Duration) {
	var retry <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-requests:
		case <-retry:
		}
		if ctx.Err() != nil {
			return
		}
		var configs map[string]*protocol.TeamConfigCapabilities
		retry = nil
		if c.TeamConfigInventory != nil {
			var timedOut bool
			configs, timedOut = c.TeamConfigInventory(ctx)
			if timedOut {
				retry = time.After(retryDelay)
			}
		}
		if ctx.Err() != nil {
			return
		}
		register := c.agentRegisterMessage()
		if len(configs) > 0 {
			register.TeamAgentConfigs = configs
			register.Capabilities = append(register.Capabilities, protocol.CapabilityTeamConfigV2)
		}
		if reflect.DeepEqual(register, last) {
			continue
		}
		if err := c.sendRegistration(ctx, conn, register); err != nil {
			if ctx.Err() == nil {
				c.logger.Warn("refresh daemon inventory failed", "error", err)
			}
			continue
		}
		last = register
	}
}
