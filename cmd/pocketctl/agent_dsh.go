package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/pocketctl/pocketctl/internal/dshapp"
)

func runDSHCommand(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" {
		fmt.Fprintln(stdout, "Attach PocketCtl to the same Host as your native DSH client:\n  dsh web --no-open\n  pocketctl agent dsh enable --url '<launch URL including token>'\n  pocketctl agent dsh status\n  pocketctl agent dsh disable\nThe daemon discovers sessions in its allowed working directories. Disabling detaches PocketCtl; it does not stop DSH.")
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	switch args[0] {
	case "enable":
		flags := flag.NewFlagSet("agent dsh enable", flag.ContinueOnError)
		flags.SetOutput(stderr)
		raw := flags.String("url", "", "Native DSH launch URL (loopback, including bootstrap token)")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return fmt.Errorf("unexpected arguments")
		}
		cfg := dshapp.Config{URL: *raw}
		client, err := dshapp.Connect(ctx, cfg)
		if err != nil {
			return err
		}
		defer client.Close()
		if err := dshapp.SaveConfig(cfg); err != nil {
			return err
		}
		fmt.Fprintln(stdout, "DSH enabled. The daemon will attach to this Host; keep the native Host running.")
	case "status":
		cfg, err := dshapp.LoadConfig()
		if os.IsNotExist(err) {
			fmt.Fprintln(stdout, "DSH disabled")
			return nil
		}
		if err != nil {
			return err
		}
		client, err := dshapp.Connect(ctx, cfg)
		if err != nil {
			return err
		}
		client.Close()
		fmt.Fprintln(stdout, "DSH enabled; native Host reachable")
	case "disable":
		if os.Getenv("POCKETCTL_DSH_URL") != "" {
			return fmt.Errorf("unset POCKETCTL_DSH_URL in the daemon environment to disable DSH")
		}
		if err := os.Remove(dshapp.ConfigPath()); err != nil && !os.IsNotExist(err) {
			return err
		}
		fmt.Fprintln(stdout, "DSH disabled; native Host remains running")
	default:
		return fmt.Errorf("unknown DSH command %q", args[0])
	}
	return nil
}
