package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestHostileSessionDocumentCorpusCoversSecurityBoundary(t *testing.T) {
	type corpusCase struct {
		ID        string   `json:"id"`
		HTML      string   `json:"html"`
		Threats   []string `json:"threats"`
		Generated *struct {
			Value string `json:"value"`
			Count int    `json:"count"`
		} `json:"generated,omitempty"`
	}
	var corpus struct {
		Version int          `json:"version"`
		Cases   []corpusCase `json:"cases"`
	}
	path := filepath.Join("..", "..", "testdata", "session-documents", "hostile-documents.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatalf("decode hostile document corpus: %v", err)
	}
	if corpus.Version != 1 {
		t.Fatalf("corpus version = %d, want 1", corpus.Version)
	}

	required := []string{
		"scripts", "event_handlers", "same_origin_access", "fetch", "xhr", "websocket",
		"css_url", "css_import", "external_images", "external_fonts", "media", "objects",
		"frames", "forms", "links", "popups", "meta_refresh", "svg_handlers",
		"malformed_markup", "oversized_input",
	}
	covered := make(map[string]bool)
	seenIDs := make(map[string]bool)
	for _, fixture := range corpus.Cases {
		if fixture.ID == "" || seenIDs[fixture.ID] {
			t.Fatalf("fixture id must be non-empty and unique: %q", fixture.ID)
		}
		seenIDs[fixture.ID] = true
		if fixture.HTML == "" && (fixture.Generated == nil || fixture.Generated.Value == "" || fixture.Generated.Count <= 0) {
			t.Fatalf("fixture %q has no static or generated payload", fixture.ID)
		}
		for _, threat := range fixture.Threats {
			covered[threat] = true
		}
	}
	for _, threat := range required {
		if !covered[threat] {
			t.Errorf("hostile document corpus does not cover %q", threat)
		}
	}
}
