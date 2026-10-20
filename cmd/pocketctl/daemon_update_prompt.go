package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/mattn/go-isatty"
	"github.com/pocketctl/pocketctl/internal/i18n"
	"github.com/pocketctl/pocketctl/internal/update"
)

func updateTerminal() bool {
	return isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stdout.Fd()) && os.Getenv("TERM") != "dumb"
}

func offerDaemonUpdate(current string, interactive bool, in io.Reader, out io.Writer, latest func(context.Context) (string, error), run func(string) error) error {
	if !interactive {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	tag, err := latest(ctx)
	if err != nil || !update.IsNewerVersion(current, tag) {
		return nil
	}
	fmt.Fprintln(out, i18n.T("update.available", current, tag))
	fmt.Fprint(out, i18n.T("update.confirm"))
	answer, err := bufio.NewReader(in).ReadString('\n')
	if err != nil {
		return nil
	}
	answer = strings.ToLower(strings.TrimSpace(answer))
	if answer != "y" && answer != "yes" {
		return nil
	}
	return run(tag)
}

func offerStatusUpdate(current string, args []string) {
	err := offerDaemonUpdate(current, updateTerminal(), os.Stdin, os.Stdout, update.CheckLatestContext, func(tag string) error {
		path, err := update.ExecutablePath()
		if err != nil {
			return err
		}
		cmd := exec.Command(path, "daemon", "update", "--version", tag)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			return err
		}
		// A fresh process reports the new executable and reads fresh daemon state.
		statusArgs := append([]string{"daemon", "status"}, args...)
		statusArgs = append(statusArgs, "--no-update-check")
		cmd = exec.Command(path, statusArgs...)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		return cmd.Run()
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("update.failed", err))
	}
}
