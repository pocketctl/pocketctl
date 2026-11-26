package agentcontrol

import (
	"bytes"
	"context"
	"encoding/json"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// The caller can disconnect after admission. The daemon owns the operation lifetime.
type AdoptionHandler func(context.Context, string, protocol.AdoptionRequest) (protocol.AdoptionReceipt, error)

func (c Client) AdoptSession(ctx context.Context, method string, req protocol.AdoptionRequest) (protocol.AdoptionReceipt, error) {
	var result protocol.AdoptionReceipt
	err := c.callPayload(ctx, method, req, &result)
	return result, err
}

func dispatchLocalAdoption(ctx context.Context, h AdoptionHandler, envelope Request) (protocol.AdoptionReceipt, error) {
	var req protocol.AdoptionRequest
	decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return protocol.AdoptionReceipt{}, invalid("invalid adoption payload")
	}
	return h(ctx, envelope.Method, req)
}
