package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/memorysync"
)

func runMemoryScopes(stdout, stderr io.Writer, args []string) int {
	return runMemoryScopesWith(stdout, stderr, args, func(ctx context.Context) (memorysync.ScopeList, error) {
		relay, token, _, err := config.LoadAuth()
		if err != nil || relay == "" || token == "" {
			return memorysync.ScopeList{}, fmt.Errorf("not_logged_in")
		}
		return memorysync.NewGrantClient(relay, token, &http.Client{Timeout: 15 * time.Second}).ListScopes(ctx)
	})
}

func runMemoryScopesWith(stdout, stderr io.Writer, args []string, list func(context.Context) (memorysync.ScopeList, error)) int {
	asJSON := false
	for _, arg := range args {
		switch arg {
		case "--help", "-h", "help":
			fmt.Fprint(stdout, memoryHelp())
			return 0
		case "--json":
			asJSON = true
		default:
			fmt.Fprintf(stderr, "pocketctl memory scopes: unknown flag %q\n", arg)
			return 2
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result, err := list(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "pocketctl memory scopes: %v\n", err)
		return 1
	}
	if result.Scopes == nil {
		result.Scopes = []memorysync.Scope{}
	}
	if asJSON {
		if err := json.NewEncoder(stdout).Encode(result); err != nil {
			return 1
		}
	} else {
		writer := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
		fmt.Fprintln(writer, "TYPE\tNAME\tSTATUS\tINSTALLATION_ID\tPERMISSIONS")
		for _, scope := range result.Scopes {
			permissions := strings.Join(scope.Permissions, ",")
			if permissions == "" {
				permissions = "-"
			}
			fmt.Fprintf(writer, "%s\t%s\t%s\t%s\t%s\n", strconv.Quote(scope.Kind), strconv.Quote(scope.Name), strconv.Quote(scope.Status), strconv.Quote(scope.InstallationID), strconv.Quote(permissions))
		}
		if err := writer.Flush(); err != nil {
			return 1
		}
		if len(result.Scopes) == 0 {
			fmt.Fprintln(stdout, "No Memory installations found.")
		}
	}
	if !result.SharedScopesAvailable {
		fmt.Fprintln(stderr, "warning: shared scope discovery unavailable; only personal installations listed")
	}
	return 0
}
