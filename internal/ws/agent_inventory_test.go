package ws

import (
	"slices"
	"sync"
	"testing"

	"github.com/pocketctl/pocketctl/internal/discovery"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestAgentInventoryRefreshRegistrationAndRemoval(t *testing.T) {
	c := &Client{agents: []string{"codex"}, agentLatests: map[string]string{"codex": "1.2"}}
	inventory := []discovery.AgentInfo{{Type: "codex", Version: "1.1", Manageable: true}, {Type: "dsh", TeamCallable: true}}
	if !c.SetAgentInventory(inventory) {
		t.Fatal("new installation was not detected")
	}
	snapshot := c.agentRegisterMessage()
	if !slices.Contains(snapshot.Agents, "dsh") || !slices.Contains(snapshot.Capabilities, protocol.CapabilityTeamDSHV1) || snapshot.AgentLatests["codex"] != "1.2" {
		t.Fatalf("incomplete register: %+v", snapshot)
	}
	if c.SetAgentInventory(inventory) {
		t.Fatal("unchanged inventory causes repeated registration")
	}
	snapshot.AgentVersions["codex"] = "mutated"
	if c.agentRegisterMessage().AgentVersions["codex"] != "1.1" {
		t.Fatal("snapshot aliases mutable inventory")
	}
	inventory[1].TeamCallable = false
	if !c.SetAgentInventory(inventory) || slices.Contains(c.agentRegisterMessage().Capabilities, protocol.CapabilityTeamDSHV1) {
		t.Fatal("offline DSH remained callable")
	}
	c.SetAgentInventory(inventory[:1])
	if slices.Contains(c.agentRegisterMessage().Agents, "dsh") {
		t.Fatal("uninstalled agent retained")
	}
}

func TestAgentInventoryConcurrentRegister(t *testing.T) {
	c := &Client{}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			c.SetAgentInventory([]discovery.AgentInfo{{Type: "dsh", TeamCallable: i%2 == 0}})
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			_ = c.agentRegisterMessage()
		}
	}()
	wg.Wait()
}
