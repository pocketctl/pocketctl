package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/i18n"
	"github.com/pocketctl/pocketctl/internal/zcode"
	"golang.org/x/term"
)

const zcodeQuotaHelp = "pocketctl agent zcode quota <bind|status|unbind>"

func runZcodeQuotaCommand(args []string, stdin *os.File, stdout, stderr io.Writer) error {
	if len(args) == 0 || (len(args) == 1 && (args[0] == "help" || args[0] == "--help")) {
		fmt.Fprintln(stdout, zcodeQuotaHelp)
		return nil
	}
	if len(args) != 1 {
		return errors.New(zcodeQuotaHelp)
	}
	r := zcode.NewQuotaReader()
	switch args[0] {
	case "bind":
		var raw []byte
		var err error
		if term.IsTerminal(int(stdin.Fd())) {
			fmt.Fprint(stderr, i18n.T("agent.zcode_quota_key_prompt"))
			raw, err = term.ReadPassword(int(stdin.Fd()))
			fmt.Fprintln(stderr)
		} else {
			raw, err = io.ReadAll(io.LimitReader(stdin, 8195))
		}
		if err != nil || len(raw) > 8194 {
			return errors.New("could not read Coding Plan API key")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := r.BindQuotaKey(ctx, strings.TrimSuffix(strings.TrimSuffix(string(raw), "\n"), "\r")); err != nil {
			return err
		}
		fmt.Fprintln(stdout, i18n.T("agent.zcode_quota_bound"))
	case "unbind":
		if err := r.UnbindQuotaKey(); err != nil {
			return err
		}
		fmt.Fprintln(stdout, i18n.T("agent.zcode_quota_unbound"))
	case "status":
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		q, err := r.Read(ctx)
		if err != nil {
			return err
		}
		if q.BindingRequired {
			fmt.Fprintln(stdout, i18n.T("agent.zcode_quota_bind_required"))
			return nil
		}
		fmt.Fprintln(stdout, q.Status)
		for _, w := range q.Windows {
			if w.RemainingPercent != nil {
				fmt.Fprintf(stdout, "%s: %g%%\n", w.ID, *w.RemainingPercent)
			}
		}
	default:
		return errors.New(zcodeQuotaHelp)
	}
	return nil
}
