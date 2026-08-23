package codexapp

import (
	"encoding/json"
	"testing"
)

func TestRequestIDPreservesStringAndNumberIdentity(t *testing.T) {
	for _, raw := range []string{`42`, `"42"`, `-7`} {
		var id RequestID
		if err := json.Unmarshal([]byte(raw), &id); err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(id)
		if err != nil {
			t.Fatal(err)
		}
		if string(encoded) != raw {
			t.Fatalf("raw=%s encoded=%s", raw, encoded)
		}
	}
	var number, text RequestID
	_ = json.Unmarshal([]byte(`42`), &number)
	_ = json.Unmarshal([]byte(`"42"`), &text)
	if number.Key() == text.Key() {
		t.Fatalf("numeric and string IDs collided: %q", number.Key())
	}
}

func TestRequestIDRejectsNullObjectAndFraction(t *testing.T) {
	for _, raw := range []string{`null`, `{}`, `[]`, `1.5`} {
		var id RequestID
		if err := json.Unmarshal([]byte(raw), &id); err == nil {
			t.Fatalf("accepted invalid ID %s", raw)
		}
	}
}
