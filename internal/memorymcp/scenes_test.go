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

func TestSceneReadToolUsesExistingQualifiedScopeGrant(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	for _, c := range []struct {
		args     string
		selected []string
	}{{`{}`, nil}, {`{"installation_id":"` + id + `"}`, []string{id}}} {
		var received []byte
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			received, _ = io.ReadAll(r.Body)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"scenes":[]}}`))
		}))
		source := &recordingSource{grant: Grant{Token: "selected", ExpiresAt: time.Now().Add(time.Minute), Origin: server.URL}}
		request := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_list_scenes","arguments":` + c.args + `}}`
		var output bytes.Buffer
		bridge := &Bridge{Grants: &CachingGrantSource{Inner: source, Now: time.Now}, Stdin: strings.NewReader(request + "\n"), Stdout: &output}
		if err := bridge.Run(context.Background()); err != nil {
			t.Fatal(err)
		}
		server.Close()
		if len(source.selections) != 1 || !reflect.DeepEqual(source.selections[0], c.selected) || string(received) != request || !strings.Contains(output.String(), `"scenes":[]`) {
			t.Fatalf("scene read not forwarded with exact scope: %s", output.String())
		}
	}
}
func TestSceneReadToolRefusesMalformedQualifiedScope(t *testing.T) {
	for _, args := range []string{`{"installation_id":null}`, `{"installation_id":1}`, `{"installation_id":"bad"}`} {
		m := jsonRpcMessage{Method: "tools/call", Params: json.RawMessage(`{"name":"memory_list_scenes","arguments":` + args + `}`)}
		if _, err := selectedScopesForMCPMessage(m); err == nil {
			t.Fatal("malformed scene selection accepted")
		}
	}
}
