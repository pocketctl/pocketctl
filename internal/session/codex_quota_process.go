package session

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type codexHostQuotaCache struct {
	snapshot *CodexQuotaSnapshot
	stamp    string
	revision uint64
	at       time.Time
}

// Host reads do not acquire leases, adopt/replace runtimes, resume threads, or
// configure project skills. When no home runtime exists, a bounded metadata-only
// stdio process reads the selected home's credentials and is always stopped.
func (sm *SessionManager) ReadCodexHostRateLimits(ctx context.Context, homeID string) (*CodexQuotaSnapshot, error) {
	p := sm.CodexRuntimeProvider()
	coord, profile, err := p.coordinatorForHomeID(homeID)
	if err != nil {
		return nil, errors.New("quota_credentials_unavailable")
	}
	p.quotaMu.Lock()
	defer p.quotaMu.Unlock()
	if err = ctx.Err(); err != nil {
		return nil, errors.New("quota_unavailable")
	}
	stamp, err := codexQuotaAuthStamp(profile.Home)
	if err != nil {
		return nil, errors.New("quota_credentials_unavailable")
	}
	revision := coord.quotaRevision.Load()
	if cached, ok := p.quotaCache[profile.ID]; ok && cached.stamp == stamp && cached.revision == revision && time.Since(cached.at) < 15*time.Second {
		return cached.snapshot, nil
	}
	var result *CodexQuotaSnapshot
	if client, generation, ok := coord.backendClient(); ok {
		result, err = readCodexQuota(ctx, client, profile.ID)
		_, nextGeneration, online := coord.backendClient()
		if !online || nextGeneration != generation {
			err = errors.New("quota_account_changed")
		}
	} else {
		var binary string
		binary, _, err = p.resolve()
		if err == nil {
			result, err = readCodexQuotaProcess(ctx, binary, profile.Home, profile.ID)
		}
	}
	if err != nil {
		if err.Error() == "quota_account_changed" {
			return nil, errors.New("quota_account_changed")
		}
		return nil, errors.New("quota_unavailable")
	}
	nextStamp, stampErr := codexQuotaAuthStamp(profile.Home)
	if stampErr != nil || stamp != nextStamp || revision != coord.quotaRevision.Load() {
		return nil, errors.New("quota_account_changed")
	}
	if p.quotaCache == nil {
		p.quotaCache = make(map[string]codexHostQuotaCache)
	}
	p.quotaCache[profile.ID] = codexHostQuotaCache{result, stamp, revision, time.Now()}
	return result, nil
}

func codexQuotaAuthStamp(home string) (string, error) {
	hash := sha256.New()
	for _, name := range []string{"auth.json", "config.toml"} {
		file, err := os.Open(filepath.Join(home, name))
		if os.IsNotExist(err) {
			fmt.Fprintln(hash, name+":missing")
			continue
		}
		if err != nil {
			return "", err
		}
		n, err := io.Copy(hash, io.LimitReader(file, 2*1024*1024+1))
		file.Close()
		if err != nil || n > 2*1024*1024 {
			return "", errors.New("invalid quota credentials")
		}
		fmt.Fprintln(hash, "\x00"+name)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

type codexQuotaStdio struct {
	input io.Writer
	lines *bufio.Scanner
	id    int
}

func (c *codexQuotaStdio) Call(ctx context.Context, method string, params any, result any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.id++
	raw, _ := json.Marshal(map[string]any{"id": c.id, "method": method, "params": params})
	if _, err := fmt.Fprintln(c.input, string(raw)); err != nil {
		return err
	}
	for c.lines.Scan() {
		var reply struct {
			ID     *int            `json:"id"`
			Method string          `json:"method"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(c.lines.Bytes(), &reply) != nil || reply.ID == nil || *reply.ID != c.id || reply.Method != "" {
			continue
		}
		if len(reply.Error) > 0 && string(reply.Error) != "null" {
			return errors.New("quota_unavailable")
		}
		if result != nil {
			return json.Unmarshal(reply.Result, result)
		}
		return nil
	}
	return errors.New("quota_unavailable")
}
func readCodexQuotaProcess(ctx context.Context, binary, home, homeID string) (*CodexQuotaSnapshot, error) {
	cmd := exec.CommandContext(ctx, binary, "app-server")
	cmd.Dir = home
	cmd.Stderr = io.Discard
	cmd.WaitDelay = time.Second
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "CODEX_HOME=") {
			cmd.Env = append(cmd.Env, value)
		}
	}
	cmd.Env = append(cmd.Env, "CODEX_HOME="+home)
	input, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		return nil, err
	}
	defer func() { input.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 4096), 2*1024*1024)
	client := &codexQuotaStdio{input: input, lines: scanner}
	if err = client.Call(ctx, "initialize", codexInitializeParams(), nil); err != nil {
		return nil, err
	}
	if _, err = fmt.Fprintln(input, `{"method":"initialized","params":{}}`); err != nil {
		return nil, err
	}
	return readCodexQuota(ctx, client, homeID)
}
