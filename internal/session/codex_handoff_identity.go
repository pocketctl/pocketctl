package session

import (
	"strings"

	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/platform"
)

// IsAlive is insufficient after PID reuse. Require the actual executable and
// exact listener argv, and bind new handoffs to the kernel process birth token.
// Legacy handoffs may be adopted only when their full binary/listener identity
// still matches; an unrelated live PID never authorizes signaling or unlinking.
func codexHandoffProcessIdentity(state *daemon.CodexAppServerState) (string, bool) {
	if state == nil || state.PID <= 0 || state.Binary == "" || state.Endpoint == "" || state.RemoteURI != "unix://"+state.Endpoint {
		return "", false
	}
	identity, err := platform.ProcessStartIdentity(state.PID)
	if err != nil || identity == "" || (state.ProcessStartIdentity != "" && state.ProcessStartIdentity != identity) {
		return "", false
	}
	processes, err := platform.NewProcessInspector().List()
	if err != nil {
		return "", false
	}
	matched := false
	for _, process := range processes {
		if process.PID != state.PID || normalizeCwd(process.Executable) != normalizeCwd(state.Binary) || len(process.Args) < 4 || process.Args[1] != "app-server" {
			continue
		}
		listeners := 0
		for index, arg := range process.Args {
			if arg == "--listen" && index+1 < len(process.Args) {
				if process.Args[index+1] != state.RemoteURI {
					return "", false
				}
				listeners++
			} else if strings.HasPrefix(arg, "--listen=") {
				if strings.TrimPrefix(arg, "--listen=") != state.RemoteURI {
					return "", false
				}
				listeners++
			}
		}
		matched = listeners == 1
		break
	}
	if !matched {
		return "", false
	}
	after, err := platform.ProcessStartIdentity(state.PID)
	return identity, err == nil && after == identity
}

func codexProcessBirthMatches(pid int, identity string) bool {
	current, err := platform.ProcessStartIdentity(pid)
	return identity != "" && err == nil && current == identity
}
