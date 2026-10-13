package platform

import (
	"bytes"
	"encoding/binary"
	"errors"
)

// KERN_PROCARGS2 contains argc, executable, padding, argv and environment.
// Consume exactly argc NUL-terminated strings: whitespace and empty arguments
// are significant, and environment entries must never be mistaken for argv.
func parseDarwinProcessArgs(pid int, raw []byte) (ProcessSnapshot, error) {
	invalid := errors.New("invalid Darwin process arguments")
	if len(raw) < 4 {
		return ProcessSnapshot{}, invalid
	}
	argc := int(binary.NativeEndian.Uint32(raw[:4]))
	raw = raw[4:]
	end := bytes.IndexByte(raw, 0)
	if argc <= 0 || argc > len(raw) || end <= 0 {
		return ProcessSnapshot{}, invalid
	}
	snapshot := ProcessSnapshot{PID: pid, Executable: string(raw[:end])}
	raw = bytes.TrimLeft(raw[end+1:], "\x00")
	for i := 0; i < argc; i++ {
		end = bytes.IndexByte(raw, 0)
		if end < 0 {
			return ProcessSnapshot{}, invalid
		}
		snapshot.Args = append(snapshot.Args, string(raw[:end]))
		raw = raw[end+1:]
	}
	return snapshot, nil
}
