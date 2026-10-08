package ws

import (
	"maps"
	"reflect"

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
	capabilities := []string{protocol.CapabilityTeamDispatchV1, protocol.CapabilityTeamContextV1, protocol.CapabilityTeamReconcileV1}
	if c.dshTeamCallable {
		capabilities = append(capabilities, protocol.CapabilityTeamDSHV1)
	}
	return protocol.RegisterMessage{
		Type: "register", DaemonID: c.daemonID, Hostname: c.hostname,
		Agents: append([]string(nil), c.agents...), AgentVersions: maps.Clone(c.agentVersions),
		AgentLatests: maps.Clone(c.agentLatests), AgentManageable: maps.Clone(c.agentManageable),
		OS: c.osName, IP: c.localIP, Arch: c.arch, Version: c.version, StartedAt: c.startedAt,
		SupportsQuotaGrant: true, SupportsDirectoryBrowse: true, Capabilities: capabilities,
	}
}
