package memorymcp

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestEvidenceReadToolsForwardExactBindingWithExplicitScopes(t *testing.T) {
	const sourceID = "11111111-1111-4111-8111-111111111111"
	const packID = "22222222-2222-4222-8222-222222222222"
	for _, name := range []string{"memory_get_evidence_reference", "memory_read_evidence_content"} {
		for _, selected := range []struct {
			name string
			args string
			want []string
		}{
			{"default", `{}`, nil},
			{"source", `{"installation_id":"` + sourceID + `"}`, []string{sourceID}},
			{"pack", `{"pack_installation_id":"` + packID + `"}`, []string{packID}},
			{"both", `{"installation_id":"` + sourceID + `","pack_installation_id":"` + packID + `"}`, []string{sourceID, packID}},
			{"same", `{"installation_id":"` + sourceID + `","pack_installation_id":"` + sourceID + `"}`, []string{sourceID}},
		} {
			t.Run(name+"/"+selected.name, func(t *testing.T) {
				var received []byte
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					received, _ = io.ReadAll(r.Body)
					w.Header().Set("content-type", "application/json")
					_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`))
				}))
				defer server.Close()
				source := &recordingSource{grant: Grant{Token: "selected", ExpiresAt: time.Now().Add(time.Minute), Origin: server.URL}}
				args := strings.TrimSuffix(selected.args, "}")
				if len(args) > 1 {
					args += ","
				}
				args += `"evidence_id":"33333333-3333-4333-8333-333333333333"`
				if name == "memory_read_evidence_content" {
					args += `,"version_id":"44444444-4444-4444-8444-444444444444","excerpt_hash":"` + strings.Repeat("a", 64) + `","source_version":"55555555-5555-4555-8555-555555555555","source_hash":"` + strings.Repeat("b", 64) + `","page":2,"max_chars":1000`
				}
				args += "}"
				request := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + name + `","arguments":` + args + `}}`
				var stdout bytes.Buffer
				bridge := &Bridge{Grants: &CachingGrantSource{Inner: source, Now: time.Now}, Stdin: strings.NewReader(request + "\n"), Stdout: &stdout}
				if err := bridge.Run(context.Background()); err != nil {
					t.Fatal(err)
				}
				if len(source.selections) != 1 || !reflect.DeepEqual(source.selections[0], selected.want) {
					t.Fatalf("wrong grant scope selection: %#v", source.selections)
				}
				if string(received) != request || !strings.Contains(stdout.String(), `"ok":true`) {
					t.Fatalf("read binding was not forwarded verbatim: body=%s response=%s", received, stdout.String())
				}
			})
		}
	}
}

func TestEvidenceReadToolsRejectMalformedScopesBeforeGrant(t *testing.T) {
	for _, name := range []string{"memory_get_evidence_reference", "memory_read_evidence_content"} {
		for _, args := range []string{`{"installation_id":null}`, `{"installation_id":123}`, `{"pack_installation_id":"bad"}`, `{"pack_installation_id":[]}`} {
			source := &recordingSource{}
			var stdout bytes.Buffer
			request := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + name + `","arguments":` + args + `}}`
			bridge := &Bridge{Grants: &CachingGrantSource{Inner: source, Now: time.Now}, Stdin: strings.NewReader(request + "\n"), Stdout: &stdout}
			if err := bridge.Run(context.Background()); err != nil {
				t.Fatal(err)
			}
			if len(source.selections) != 0 || !strings.Contains(stdout.String(), `"message":"invalid_scope_selection"`) {
				t.Fatalf("malformed scope reached grant or wrong rejection: %s %s", name, stdout.String())
			}
		}
	}
}

func TestEvidenceMutationsRemainDisallowed(t *testing.T) {
	for _, name := range []string{"memory_write_evidence", "memory_delete_evidence", "memory_execute_evidence", "memory_read_arbitrary_file"} {
		if allowedMemoryTool(jsonRpcMessage{Method: "tools/call", Params: json.RawMessage(`{"name":"` + name + `"}`)}) {
			t.Fatalf("non-read tool allowed: %s", name)
		}
	}
}
