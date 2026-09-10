package codexapp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestSkillsCatalogResolution(t *testing.T) {
	a := SkillMetadata{Name: "review", Path: "/project/.claude/skills/review/SKILL.md", Enabled: true}
	b := SkillMetadata{Name: "review", Path: "/project/.codex/skills/review/SKILL.md", Enabled: true}
	catalog := SkillsCatalog{Cwd: "/project", Skills: []SkillMetadata{a, b}}
	if _, err := catalog.ResolveSkill("review", ""); !errors.Is(err, ErrSkillAmbiguous) {
		t.Fatalf("expected disambiguation: %v", err)
	}
	if got, err := catalog.ResolveSkill("review", a.Path); err != nil || got.Path != a.Path {
		t.Fatalf("wrong source: %+v %v", got, err)
	}
	for _, p := range []string{"/other-project/SKILL.md", "/project/.claude/skills/review/../review/SKILL.md"} {
		if _, err := catalog.ResolveSkill("review", p); !errors.Is(err, ErrSkillNotFound) {
			t.Fatalf("accepted path outside returned catalog: %s %v", p, err)
		}
	}
	catalog.Skills = []SkillMetadata{a, a}
	if _, err := catalog.ResolveSkill("review", ""); err != nil {
		t.Fatalf("duplicate native records should not create ambiguity: %v", err)
	}
	catalog.Skills[0].Enabled = false
	catalog.Skills = catalog.Skills[:1]
	if _, err := catalog.ResolveSkill("review", a.Path); !errors.Is(err, ErrSkillDisabled) {
		t.Fatalf("disabled skill accepted: %v", err)
	}
	if _, err := catalog.ResolveSkill("different-name", a.Path); !errors.Is(err, ErrSkillNotFound) {
		t.Fatalf("name/path mismatch accepted: %v", err)
	}
}

func TestListSkillsRetainsNativeErrorsAndDuplicateNames(t *testing.T) {
	upgrader := websocket.Upgrader{}
	wire := make(chan map[string]json.RawMessage, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var msg map[string]json.RawMessage
		if conn.ReadJSON(&msg) != nil {
			return
		}
		wire <- msg
		_ = conn.WriteJSON(map[string]any{"id": msg["id"], "result": SkillsListResponse{Data: []SkillsCatalog{{Cwd: "/project", Skills: []SkillMetadata{{Name: "review", Path: "/project/a/SKILL.md", Enabled: true}, {Name: "review", Path: "/project/b/SKILL.md", Enabled: false}}, Errors: []SkillLoadError{{Path: "/project/broken/SKILL.md", Message: "invalid frontmatter"}}}}}})
	}))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+server.URL[4:], nil)
	if err != nil {
		t.Fatal(err)
	}
	client := NewClient(conn)
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result, err := client.ListSkills(ctx, []string{"/project"}, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Data) != 1 || len(result.Data[0].Skills) != 2 || len(result.Data[0].Errors) != 1 {
		t.Fatalf("lost native catalog information: %+v", result)
	}
	msg := <-wire
	var method string
	_ = json.Unmarshal(msg["method"], &method)
	var params map[string]json.RawMessage
	_ = json.Unmarshal(msg["params"], &params)
	if method != "skills/list" || len(params) != 2 || string(params["forceReload"]) != "true" || string(params["cwds"]) != "[\"/project\"]" {
		t.Fatalf("unexpected wire contract: %s %s", method, msg["params"])
	}
}

func TestListSkillsRequiresExplicitDirectory(t *testing.T) {
	var client *Client // Validation must happen before transport access.
	for _, cwds := range [][]string{nil, {}, {""}, {"/project", ""}} {
		if _, err := client.ListSkills(context.Background(), cwds, true); err == nil {
			t.Fatalf("accepted implicit cwd: %v", cwds)
		}
	}
}
