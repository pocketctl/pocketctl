package teamdelivery

import (
	"context"
	"strings"
	"testing"
)

func TestFrozenStepBundleContainsAuthorizedIndexAndExactBytes(t *testing.T) {
	client, auth, hash, data, _ := stepInputFixture(t, nil, false, false)
	files, err := FreezeStepInputBundle(context.Background(), client, auth, hash, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 || files[0].Path != "inputs.json" || !strings.HasPrefix(files[1].Path, "files/") || string(files[1].Data) != string(data) || files[1].SHA256 != inputDigest(data) {
		t.Fatal("frozen input bytes or index missing")
	}
	for _, file := range files {
		if inputDigest(file.Data) != file.SHA256 {
			t.Fatal("digest mismatch")
		}
	}
}
func TestFrozenStepBundleNeverExportsRevokedOrChangedBytes(t *testing.T) {
	for _, corrupt := range []bool{false, true} {
		client, auth, hash, _, _ := stepInputFixture(t, nil, corrupt, !corrupt)
		if files, err := FreezeStepInputBundle(context.Background(), client, auth, hash, t.TempDir()); err == nil || files != nil {
			t.Fatal("unauthorized input exported")
		}
	}
}
