package ws

import (
	"net/http"
	"slices"
	"sync"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestRelayHTTPAndDeliveryCapabilityFollowBootstrap(t *testing.T) {
	c := &Client{relayURL: "wss://relay.example/ws", token: "initial"}
	if slices.Contains(c.agentRegisterMessage().Capabilities, protocol.CapabilityTeamDeliveryV1) {
		t.Fatal("unstarted worker advertised")
	}
	c.SetTeamDeliveryEnabled(true)
	if !slices.Contains(c.agentRegisterMessage().Capabilities, protocol.CapabilityTeamDeliveryV1) {
		t.Fatal("ready worker missing capability")
	}
	c.SetTeamDeliveryEnabled(false)
	if slices.Contains(c.agentRegisterMessage().Capabilities, protocol.CapabilityTeamDeliveryV1) {
		t.Fatal("disabled worker advertised")
	}
	c.SetRelayPin("invalid-pin")
	client := c.RelayHTTPClient()
	transport := client.Transport.(*http.Transport)
	if transport.TLSClientConfig == nil || transport.TLSClientConfig.InsecureSkipVerify || transport.TLSClientConfig.VerifyPeerCertificate == nil {
		t.Fatal("HTTP does not preserve TLS verification and pin")
	}
	if err := transport.TLSClientConfig.VerifyPeerCertificate(nil, nil); err == nil {
		t.Fatal("pin accepted absent certificates")
	}
	if client.CheckRedirect(nil, nil) != http.ErrUseLastResponse {
		t.Fatal("bearer redirects permitted")
	}
	c.UpdateToken("refreshed")
	if c.AccessToken() != "refreshed" {
		t.Fatal("stale token")
	}
}

func TestStepInputCapabilityRequiresBothReadyDeliveryAndOptIn(t *testing.T) {
	c := &Client{}
	c.SetTeamStepsEnabled(true)
	if slices.Contains(c.agentRegisterMessage().Capabilities, protocol.CapabilityTeamStepsV1) {
		t.Fatal("step capability without ready publisher")
	}
	c.SetTeamDeliveryEnabled(true)
	if !slices.Contains(c.agentRegisterMessage().Capabilities, protocol.CapabilityTeamStepsV1) {
		t.Fatal("ready opt-in missing")
	}
	c.SetTeamStepsEnabled(false)
	if slices.Contains(c.agentRegisterMessage().Capabilities, protocol.CapabilityTeamStepsV1) {
		t.Fatal("step capability survives opt-out")
	}
	c.SetTeamStepsEnabled(true)
	c.SetTeamDeliveryEnabled(false)
	if slices.Contains(c.agentRegisterMessage().Capabilities, protocol.CapabilityTeamStepsV1) {
		t.Fatal("step capability survives disabled publisher")
	}
}

func TestDeliveryTokenAndCapabilityConcurrentAccess(t *testing.T) {
	c := &Client{}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for range 100 {
			c.UpdateToken("next")
			c.SetTeamDeliveryEnabled(true)
		}
	}()
	go func() {
		defer wg.Done()
		for range 100 {
			_ = c.AccessToken()
			_ = c.agentRegisterMessage()
		}
	}()
	wg.Wait()
}
