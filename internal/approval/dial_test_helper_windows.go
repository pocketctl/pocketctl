//go:build windows

package approval

import (
	"net"
	"testing"

	"github.com/Microsoft/go-winio"
)

func dialIPC(t *testing.T, addr string) net.Conn {
	t.Helper()
	conn, err := winio.DialPipe(addr, nil)
	if err != nil {
		t.Fatalf("dial pipe %s: %v", addr, err)
	}
	return conn
}
