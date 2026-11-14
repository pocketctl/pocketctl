package session

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
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
	if state.ProcessExecutable != "" && normalizeCwd(process.Executable) != normalizeCwd(state.ProcessExecutable) {
		return false
	}
	if normalizeCwd(process.Executable) != normalizeCwd(state.Binary) {
		// New handoffs pin the ready process image, which may have replaced the
		// npm Node launcher through execve. Old handoffs require proof that this
		// exact image is the native dependency of the saved npm package.
		if state.ProcessExecutable != "" && filepath.Base(process.Executable) != "node" ||
			state.ProcessExecutable == "" && codexNpmExecutableMatches(state.Binary, state.Version, process.Executable) {
			commandIndex = 1
		} else {
			// npm's executable is a Node script. Accept only the exact script at the
			// interpreter's script position; never search arbitrary argv for codex.js.
			if len(args) < 3 || !filepath.IsAbs(args[1]) || normalizeCwd(args[1]) != normalizeCwd(state.Binary) || !codexNodeInterpreterMatches(state.Binary, process.Executable) {
				return false
			}
			commandIndex = 2
		}
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

func codexNpmPlatform(goos, arch string) (string, string) {
	switch goos + "/" + arch {
	case "darwin/arm64":
		return "codex-darwin-arm64", "aarch64-apple-darwin"
	case "darwin/amd64":
		return "codex-darwin-x64", "x86_64-apple-darwin"
	case "linux/arm64":
		return "codex-linux-arm64", "aarch64-unknown-linux-musl"
	case "linux/amd64":
		return "codex-linux-x64", "x86_64-unknown-linux-musl"
	case "windows/arm64":
		return "codex-win32-arm64", "aarch64-pc-windows-msvc"
	case "windows/amd64":
		return "codex-win32-x64", "x86_64-pc-windows-msvc"
	}
	return "", ""
}

type codexNpmMetadata struct {
	Name                 string            `json:"name"`
	Version              string            `json:"version"`
	OptionalDependencies map[string]string `json:"optionalDependencies"`
}

func readCodexNpmPackage(path string) (codexNpmMetadata, bool) {
	var metadata codexNpmMetadata
	file, err := os.Open(filepath.Join(path, "package.json"))
	if err != nil {
		return metadata, false
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 16*1024+1))
	if err != nil || len(data) > 16*1024 {
		return metadata, false
	}
	err = json.Unmarshal(data, &metadata)
	return metadata, err == nil
}

// Recover a legacy JS-only handoff without accepting arbitrary "codex" argv.
// Resolve the same platform package locations used by Node module resolution;
// package identities, version, executable path, birth token and listener must
// all agree. Never run a launcher to discover its native dependency.
func codexNpmExecutableMatches(script, version, executable string) bool {
	script, err := filepath.EvalSymlinks(script)
	if err != nil || filepath.Base(script) != "codex.js" || filepath.Base(filepath.Dir(script)) != "bin" {
		return false
	}
	root := filepath.Dir(filepath.Dir(script))
	launcher, ok := readCodexNpmPackage(root)
	version = strings.TrimPrefix(version, "v")
	if !ok || launcher.Name != "@openai/codex" || version == "" {
		return false
	}
	pkg, triple := codexNpmPlatform(runtime.GOOS, runtime.GOARCH)
	if pkg == "" {
		return false
	}
	name := "codex"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	actual, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return false
	}
	matches := func(base string) bool {
		expected, err := filepath.EvalSymlinks(filepath.Join(base, "vendor", triple, "bin", name))
		if err != nil || expected != actual {
			return false
		}
		info, err := os.Stat(expected)
		return err == nil && info.Mode().IsRegular() && (runtime.GOOS == "windows" || info.Mode().Perm()&0111 != 0)
	}
	roots := []string{filepath.Join(root, "node_modules", "@openai", pkg)}
	for dir := filepath.Dir(root); ; dir = filepath.Dir(dir) {
		if filepath.Base(dir) == "node_modules" {
			roots = append(roots, filepath.Join(dir, "@openai", pkg))
		}
		if filepath.Dir(dir) == dir {
			break
		}
	}
	for _, candidate := range roots {
		metadata, ok := readCodexNpmPackage(candidate)
		dependency := launcher.OptionalDependencies["@openai/"+pkg]
		aliasVersion := version + "-" + strings.TrimPrefix(pkg, "codex-")
		exactPackage := dependency == version && metadata.Name == "@openai/"+pkg && metadata.Version == version
		exactAlias := dependency == "npm:@openai/codex@"+aliasVersion && metadata.Name == "@openai/codex" && metadata.Version == aliasVersion
		if ok && (exactPackage || exactAlias) && matches(candidate) {
			return true
		}
	}
	return launcher.Version == version && matches(root) // Legacy packages bundled vendor/ directly.
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
