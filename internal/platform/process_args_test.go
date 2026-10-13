package platform

import (
	"encoding/binary"
	"reflect"
	"testing"
)

func TestDarwinProcessArgsPreservesArgumentBoundaries(t *testing.T) {
	raw := make([]byte, 4)
	binary.NativeEndian.PutUint32(raw, 6)
	raw = append(raw, []byte("/opt/node\x00\x00\x00node\x00/path with spaces/codex.js\x00app-server\x00\x00--listen\x00unix:///tmp/a b.sock\x00SECRET=hidden\x00")...)
	got, err := parseDarwinProcessArgs(42, raw)
	want := []string{"node", "/path with spaces/codex.js", "app-server", "", "--listen", "unix:///tmp/a b.sock"}
	if err != nil || got.Executable != "/opt/node" || got.PID != 42 || !reflect.DeepEqual(got.Args, want) {
		t.Fatalf("snapshot=%+v err=%v", got, err)
	}
	for _, bad := range [][]byte{nil, raw[:3], raw[:10], raw[:len(raw)-len("SECRET=hidden\x00")-1], {255, 255, 255, 127}} {
		if _, err := parseDarwinProcessArgs(42, bad); err == nil {
			t.Fatal("accepted truncated process arguments")
		}
	}
}
