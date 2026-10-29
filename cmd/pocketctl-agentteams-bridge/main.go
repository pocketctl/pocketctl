// pocketctl-agentteams-bridge is an opt-in, fixed-Worker transport service.
// It owns no scheduler and does not accept or publish PocketCtl deliveries.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/pocketctl/pocketctl/internal/agentteams"
	"github.com/pocketctl/pocketctl/internal/session"
)

type bridgeConfig struct {
	Listen              string
	Installation        string
	Scope               string
	JournalRoot         string
	TeamID              string
	TeamRoomID          string
	WorkerMatrixID      string
	ControllerEndpoint  string
	WorkerEndpoint      string
	ControllerTokenFile string
	BridgeTokenFile     string
	MCPConfigFile       string
	PythonCommand       []string
}

func privateFile(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > limit {
		return nil, errors.New("bridge_private_file_invalid")
	}
	data, err := os.ReadFile(path)
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("bridge_private_file_unavailable")
	}
	return data, nil
}
func credential(path string) func(context.Context) (string, error) {
	return func(ctx context.Context) (string, error) {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		data, err := privateFile(path, 8192)
		if err != nil {
			return "", agentteams.ErrCredential
		}
		return strings.TrimSpace(string(data)), nil
	}
}
func run() error {
	path := flag.String("config", "", "private installation configuration file")
	initialize := flag.Bool("init", false, "initialize a new empty journal offline, then exit; never resets an existing installation")
	flag.Parse()
	data, err := privateFile(*path, 32768)
	if err != nil {
		return err
	}
	var config bridgeConfig
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&config) != nil {
		return errors.New("bridge_configuration_invalid")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("bridge_configuration_invalid")
	}
	if *initialize {
		j, err := session.InitializeAgentTeamsJournal(config.JournalRoot, config.Scope, config.Installation)
		if err != nil {
			return err
		}
		defer j.Close()
		fmt.Println("AgentTeams bridge journal initialized; no remote execution")
		return nil
	}
	if _, _, err = net.SplitHostPort(config.Listen); err != nil {
		return errors.New("bridge_listen_invalid")
	}
	j, err := session.OpenAgentTeamsJournal(config.JournalRoot, config.Scope, config.Installation)
	if err != nil {
		return err
	}
	defer j.Close()
	mcp, err := agentteams.NewMCPProcess(config.PythonCommand, config.MCPConfigFile)
	if err != nil {
		return err
	}
	reader, err := agentteams.NewClient(config.ControllerEndpoint, credential(config.ControllerTokenFile), nil)
	if err != nil {
		return err
	}
	executor, err := session.NewAgentTeamsExecutor(j, session.AgentTeamsExecutorConfig{TeamID: config.TeamID, TeamRoomID: config.TeamRoomID, WorkerMatrixID: config.WorkerMatrixID}, mcp, reader)
	if err != nil {
		return err
	}
	if config.WorkerEndpoint != "" {
		if err = executor.ConfigureWorker(config.WorkerEndpoint, nil); err != nil {
			return err
		}
	}
	handler, err := session.NewAgentTeamsBridgeHandler(executor, config.Installation, credential(config.BridgeTokenFile))
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server := &http.Server{Addr: config.Listen, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 2 * time.Minute, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16384, BaseContext: func(net.Listener) context.Context { return ctx }}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		server.Shutdown(shutdown)
	}()
	fmt.Println("AgentTeams bridge ready; fixed installation, no automatic retries")
	if err = server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "AgentTeams bridge stopped:", err)
		os.Exit(1)
	}
}
