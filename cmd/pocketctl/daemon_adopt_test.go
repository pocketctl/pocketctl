package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

const testNativeThread = "01896022-9a13-7000-8000-000000000001"

func TestDaemonAdoptArguments(t *testing.T) {
	for _, args := range [][]string{{}, {"--wait=3m", testNativeThread}, {"--wait=-1s", testNativeThread}, {"--cancel", testNativeThread}, {"--wait=1s", "--status", testNativeThread}, {"--unarchive", "--cancel", "--operation=op1", testNativeThread}, {"--status", "--cancel", testNativeThread}, {"--operation=abc", testNativeThread}, {"../x"}, {"--wait=0s", testNativeThread}} {
		if _, err := parseAdoptionOptions(args, io.Discard); err == nil {
			t.Errorf("accepted %v", args)
		}
	}
	o, err := parseAdoptionOptions([]string{"--wait=2m", "--unarchive", "--json", testNativeThread}, io.Discard)
	if err != nil || o.request.WaitMS != 120000 || !o.json || !o.request.Unarchive || o.request.RequestID == "" {
		t.Fatalf("%+v %v", o, err)
	}
}
func TestDaemonAdoptPollsSameOperation(t *testing.T) {
	var calls []string
	var out, progress bytes.Buffer
	call := func(ctx context.Context, method string, req protocol.AdoptionRequest) (protocol.AdoptionReceipt, error) {
		calls = append(calls, method)
		r := protocol.AdoptionReceipt{SessionID: req.SessionID, OperationID: "operation-1", Phase: "waiting", Reason: "active_writer"}
		if method == agentcontrol.MethodAdoptStatus {
			if req.OperationID != "operation-1" || req.Unarchive || req.WaitMS != 0 {
				t.Fatalf("poll changed operation or replayed mutation: %+v", req)
			}
			r.Phase = "managed"
			r.LocalManaged = true
			r.Reason = "managed"
		}
		return r, nil
	}
	if code := runDaemonAdopt([]string{"--json", "--wait=2m", testNativeThread}, &out, &progress, call); code != 0 {
		t.Fatal(code, out.String())
	}
	var r protocol.AdoptionReceipt
	if len(calls) != 2 || json.Unmarshal(out.Bytes(), &r) != nil || r.RemoteReady || !r.LocalManaged || !strings.Contains(progress.String(), "operation-1") {
		t.Fatalf("calls %v, output %s, progress %s", calls, out.String(), progress.String())
	}
}
func TestDaemonAdoptFailureExitAndJSON(t *testing.T) {
	for _, v := range []struct {
		reason string
		err    error
		code   int
	}{
		{"operation_not_found", &agentcontrol.ProtocolError{Code: "operation_not_found", Message: "missing operation"}, 5},
		{"active_writer", nil, 3}, {"unsupported_source", nil, 4}, {"archived", nil, 3}, {"probe_timeout", nil, 3}, {"daemon_upgrade_required", &agentcontrol.ProtocolError{Code: agentcontrol.ErrInvalidRequest, Message: "unknown method "}, 4}, {"daemon_unavailable", errors.New("dial: unavailable"), 5},
	} {
		var out bytes.Buffer
		c := runDaemonAdopt([]string{"--json", testNativeThread}, &out, io.Discard, func(context.Context, string, protocol.AdoptionRequest) (protocol.AdoptionReceipt, error) {
			return protocol.AdoptionReceipt{SessionID: testNativeThread, Phase: "blocked", Reason: v.reason, AllowedActions: []string{"wait"}}, v.err
		})
		var r protocol.AdoptionReceipt
		if c != v.code || json.Unmarshal(out.Bytes(), &r) != nil || r.Reason != v.reason || r.SessionID != testNativeThread {
			t.Errorf("%s: code=%d result=%s", v.reason, c, out.String())
		}
	}
}
