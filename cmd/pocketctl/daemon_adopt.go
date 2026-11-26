package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/i18n"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

type adoptionOptions struct {
	method  string
	request protocol.AdoptionRequest
	json    bool
}

func parseAdoptionOptions(args []string, out io.Writer) (adoptionOptions, error) {
	var opts adoptionOptions
	flags := flag.NewFlagSet("daemon adopt", flag.ContinueOnError)
	flags.SetOutput(out)
	flags.Usage = func() { fmt.Fprintln(out, i18n.T("adopt.usage")) }
	wait := flags.Duration("wait", 0, "")
	status := flags.Bool("status", false, "")
	cancel := flags.Bool("cancel", false, "")
	flags.BoolVar(&opts.json, "json", false, "")
	flags.StringVar(&opts.request.OperationID, "operation", "", "")
	flags.BoolVar(&opts.request.Unarchive, "unarchive", false, "")
	if err := flags.Parse(args); err != nil {
		return opts, err
	}
	waitSet := false
	flags.Visit(func(f *flag.Flag) {
		if f.Name == "wait" {
			waitSet = true
		}
	})
	if flags.NArg() != 1 || !validCodexThreadID(flags.Arg(0)) || *status && *cancel ||
		waitSet && (*wait < time.Millisecond || *wait > 2*time.Minute) ||
		(*status || *cancel) && (waitSet || opts.request.Unarchive) ||
		*cancel && opts.request.OperationID == "" ||
		opts.request.OperationID != "" && (!validAdoptionID(opts.request.OperationID) || (!*cancel && !*status)) {
		return opts, errors.New(i18n.T("adopt.usage"))
	}
	opts.request.SessionID = flags.Arg(0)
	opts.request.WaitMS = wait.Milliseconds()
	switch {
	case *status:
		opts.method = agentcontrol.MethodAdoptStatus
	case *cancel:
		opts.method = agentcontrol.MethodAdoptCancel
	default:
		opts.method = agentcontrol.MethodAdopt
		opts.request.RequestID = uuid.NewString()
	}
	return opts, nil
}

func adoptionExit(method string, r protocol.AdoptionReceipt) int {
	if method == agentcontrol.MethodAdoptStatus {
		return 0
	}
	if method == agentcontrol.MethodAdoptCancel {
		if r.Phase == "cancelled" {
			return 0
		}
		return 3
	}
	if r.LocalManaged && r.Phase == "managed" {
		return 0
	}
	switch r.Reason {
	case "unsupported_source", "subsession", "cwd_not_authorized", "permission_denied", "cli_missing", "cli_unsupported", "daemon_upgrade_required":
		return 4
	case "unverified", "operation_not_found":
		return 5
	}
	if r.Phase == "failed" && !r.Retryable {
		return 5
	}
	return 3
}

func adoptionCallFailure(out, errs io.Writer, opts adoptionOptions, err error) int {
	code, reason := 5, "daemon_unavailable"
	var p *agentcontrol.ProtocolError
	if errors.As(err, &p) {
		switch {
		case p.Code == agentcontrol.ErrUnsupportedVersion || p.Code == agentcontrol.ErrInvalidRequest && strings.Contains(p.Message, "unknown method"):
			code, reason = 4, "daemon_upgrade_required"
		case p.Code == "operation_not_found":
			reason = p.Code
		case p.Code == agentcontrol.ErrInvalidRequest:
			code, reason = 2, "invalid_request"
		default:
			reason = "unverified"
		}
	}
	if opts.json {
		_ = json.NewEncoder(out).Encode(map[string]string{"session_id": opts.request.SessionID, "operation_id": opts.request.OperationID, "phase": "failed", "reason": reason})
	} else {
		fmt.Fprintln(errs, i18n.T("adopt."+reason), err)
	}
	return code
}

func renderAdoption(out io.Writer, r protocol.AdoptionReceipt) {
	fmt.Fprintln(out, i18n.T("diagnose.session", r.SessionID))
	if r.OperationID != "" {
		fmt.Fprintln(out, i18n.T("adopt.operation", r.OperationID))
	}
	fmt.Fprintln(out, i18n.T("adopt.result", r.Phase, r.Reason))
	if r.ArchiveChanged {
		fmt.Fprintln(out, i18n.T("adopt.archive_changed"))
	}
	key := "adopt." + r.Reason
	if label := i18n.T(key); label != key {
		fmt.Fprintln(out, label)
	}
	if r.LocalManaged {
		key := "diagnose.relay_disconnected"
		if r.RemoteReady {
			key = "diagnose.relay_connected"
		}
		fmt.Fprintln(out, i18n.T("diagnose.relay", i18n.T(key)))
	}
	if slices.Contains(r.AllowedActions, "adopt") {
		fmt.Fprintf(out, "  pocketctl daemon adopt %s\n", r.SessionID)
	}
	if slices.Contains(r.AllowedActions, "wait") {
		fmt.Fprintf(out, "  pocketctl daemon adopt --wait=2m %s\n", r.SessionID)
	}
	if slices.Contains(r.AllowedActions, "unarchive") {
		fmt.Fprintf(out, "  pocketctl daemon adopt --unarchive %s\n", r.SessionID)
	}
	if slices.Contains(r.AllowedActions, "cancel") {
		fmt.Fprintf(out, "  pocketctl daemon adopt --cancel --operation=%s %s\n", r.OperationID, r.SessionID)
	}
}

func runDaemonAdopt(args []string, out, errs io.Writer, call agentcontrol.AdoptionHandler) int {
	opts, err := parseAdoptionOptions(args, errs)
	if errors.Is(err, flag.ErrHelp) {
		return 0
	}
	if err != nil {
		fmt.Fprintln(errs, err)
		return 2
	}
	method, req := opts.method, opts.request
	var receipt protocol.AdoptionReceipt
	lastPhase := ""
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		receipt, err = call(ctx, method, req)
		cancel()
		if err != nil {
			opts.request.OperationID = req.OperationID
			return adoptionCallFailure(out, errs, opts, err)
		}
		if receipt.SessionID != req.SessionID || req.OperationID != "" && receipt.OperationID != req.OperationID || receipt.Phase == "" {
			return adoptionCallFailure(out, errs, opts, &agentcontrol.ProtocolError{Code: "unverified", Message: "invalid adoption receipt"})
		}
		if opts.method != agentcontrol.MethodAdopt || (receipt.Phase != "checking" && receipt.Phase != "binding" && receipt.Phase != "waiting") {
			break
		}
		if receipt.OperationID == "" {
			return adoptionCallFailure(out, errs, opts, &agentcontrol.ProtocolError{Code: "unverified", Message: "missing operation id"})
		}
		if lastPhase != receipt.Phase {
			fmt.Fprintln(errs, i18n.T("adopt.progress", receipt.OperationID, receipt.Phase))
			lastPhase = receipt.Phase
		}
		method = agentcontrol.MethodAdoptStatus
		req = protocol.AdoptionRequest{SessionID: req.SessionID, OperationID: receipt.OperationID}
		time.Sleep(time.Second)
	}
	if opts.json {
		if err = json.NewEncoder(out).Encode(receipt); err != nil {
			return 5
		}
	} else {
		renderAdoption(out, receipt)
	}
	return adoptionExit(opts.method, receipt)
}
