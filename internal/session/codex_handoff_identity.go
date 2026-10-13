package session

import (
	"bufio"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

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
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	process, err := platform.InspectProcess(ctx, state.PID)
	if err != nil || !codexHandoffArgsMatch(state, process) {
		return "", false
	}

	after, err := platform.ProcessStartIdentity(state.PID)
	return identity, err == nil && after == identity
}

func codexProcessBirthMatches(pid int, identity string) bool {
	current, err := platform.ProcessStartIdentity(pid)
	return identity != "" && err == nil && current == identity
}

func codexHandoffArgsMatch(state *daemon.CodexAppServerState, process platform.ProcessSnapshot) bool {
	if process.PID != state.PID || !filepath.IsAbs(process.Executable) || !filepath.IsAbs(state.Binary) {
		return false
	}
	args := process.Args
	commandIndex := 1
	if normalizeCwd(process.Executable) != normalizeCwd(state.Binary) {
		// npm's executable is a Node script. Accept only the exact script at the
		// interpreter's script position; never search arbitrary argv for codex.js.
		if len(args) < 3 || !filepath.IsAbs(args[1]) || normalizeCwd(args[1]) != normalizeCwd(state.Binary) || !codexNodeInterpreterMatches(state.Binary, process.Executable) {
			return false
		}
		commandIndex = 2
	}
	if len(args) <= commandIndex || args[commandIndex] != "app-server" {
		return false
	}
	listeners := 0
	for index := commandIndex + 1; index < len(args); index++ {
		arg := args[index]
		if arg == "--" {
			return false
		}
		if arg == "--listen" {
			if index+1 >= len(args) || args[index+1] != state.RemoteURI {
				return false
			}
			listeners++
			index++
		} else if strings.HasPrefix(arg, "--listen=") {
			if strings.TrimPrefix(arg, "--listen=") != state.RemoteURI {
				return false
			}
			listeners++
		}
	}
	return listeners == 1
}

func codexNodeInterpreterMatches(script, executable string) bool {
	if filepath.Base(executable) != "node" {
		return false
	}
	file, err := os.Open(script)
	if err != nil {
		return false
	}
	defer file.Close()
	line, err := bufio.NewReader(io.LimitReader(file, 256)).ReadString('\n')
	if err != nil {
		return false
	}
	line = strings.TrimSpace(line)
	if line == "#!/usr/bin/env node" {
		return true
	}
	if !strings.HasPrefix(line, "#!/") {
		return false
	}
	interpreter := strings.TrimPrefix(line, "#!")
	return normalizeCwd(interpreter) == normalizeCwd(executable)
}
