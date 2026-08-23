//go:build !windows

package approval

import (
	"net"
	"testing"
)

func dialIPC(t *testing.T, addr string) net.Conn {
	t.Helper()
	conn, err := net.Dial("unix", addr)
	if err != nil {
		t.Fatalf("dial unix %s: %v", addr, err)
	}
	return conn
}
