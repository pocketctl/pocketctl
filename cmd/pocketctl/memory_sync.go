package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"strings"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/memorysync"
)

// memorySyncDeps seams the command for tests; production wires Relay/Memory.
type memorySyncDeps struct {
	collect func(ctx context.Context, repoPath string) (*memorysync.Snapshot, error)
	upload  func(ctx context.Context, snapshot *memorysync.Snapshot) (memorysync.SyncResult, error)
}

// memorySyncRepoOptions is the parsed `pocketctl memory sync-repo` surface.
type memorySyncRepoOptions struct {
	RepoPath            string
	ScopeInstallationID string
	DryRun              bool
	Committed           bool
	IncludePaths        []string
	AllowPartial        bool
	AllowEmpty          bool
	Full                bool
}

var scopeInstallationIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func parseMemorySyncRepoFlags(args []string) (memorySyncRepoOptions, error) {
	options := memorySyncRepoOptions{}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--repo":
			if i+1 >= len(args) {
				return options, fmt.Errorf("--repo requires a path")
			}
			i++
			options.RepoPath = args[i]
		case "--scope-installation-id":
			if i+1 >= len(args) {
				return options, fmt.Errorf("--scope-installation-id requires a uuid")
			}
			i++
			options.ScopeInstallationID = args[i]
		case "--allow-empty":
			options.AllowEmpty = true
		case "--committed":
			options.Committed = true
		case "--allow-partial":
			options.AllowPartial = true
		case "--full":
			options.Full = true
		case "--include":
			if i+1 >= len(args) {
				return options, fmt.Errorf("--include requires a repository-relative path")
			}
			i++
			options.IncludePaths = append(options.IncludePaths, args[i])
		case "--dry-run":
			options.DryRun = true
		default:
			return options, fmt.Errorf("unknown flag %q", args[i])
		}
	}
	if options.RepoPath == "" {
		return options, fmt.Errorf("--repo is required")
	}
	if options.ScopeInstallationID != "" && !scopeInstallationIDPattern.MatchString(options.ScopeInstallationID) {
		return options, fmt.Errorf("--scope-installation-id must be a uuid")
	}
	return options, nil
}

// runMemorySyncRepo is the `pocketctl memory sync-repo` entry point.
func runMemorySyncRepo(stdout, stderr io.Writer, args []string) int {
	return runMemorySyncRepoWith(stdout, stderr, args, memorySyncDeps{
		collect: func(ctx context.Context, repoPath string) (*memorysync.Snapshot, error) {
			options := memorySyncRepoOptionsFromContext(ctx)
			return memorysync.CollectWithOptions(ctx, repoPath, memorysync.DefaultLimits(), memorysync.CollectOptions{ReadCommitted: options.Committed, IncludePaths: options.IncludePaths})
		},
		upload: func(ctx context.Context, snapshot *memorysync.Snapshot) (memorysync.SyncResult, error) {
			relayURL, accessToken, _, err := config.LoadAuth()
			if err != nil || relayURL == "" || accessToken == "" {
				return memorysync.SyncResult{}, fmt.Errorf("not_logged_in")
			}
			options := memorySyncRepoOptionsFromContext(ctx)
			grantClient := memorysync.NewGrantClient(relayURL, accessToken, nil)
			scopeID := options.ScopeInstallationID
			grantSource := memorysync.GrantSourceFunc(func(ctx context.Context, _ string) (memorysync.Grant, error) {
				return grantClient.CodegraphGrant(ctx, scopeID)
			})
			client := memorysync.NewUploadClient(memorysync.UploadClientOptions{
				GrantSource: grantSource,
				FullUpload:  options.Full,
			})
			result, err := client.SyncSnapshot(ctx, idempotencyKeyFor(snapshot), snapshot)
			if err != nil {
				return memorysync.SyncResult{}, err
			}
			result.ViewURL = memoryCodeGraphViewURL(relayURL, result.Repository, options.ScopeInstallationID)
			return result, nil
		},
	})
}

type memorySyncContextKey struct{}

func memorySyncRepoOptionsFromContext(ctx context.Context) memorySyncRepoOptions {
	options, _ := ctx.Value(memorySyncContextKey{}).(memorySyncRepoOptions)
	return options
}

func runMemorySyncRepoWith(stdout, stderr io.Writer, args []string, deps memorySyncDeps) int {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		fmt.Fprint(stdout, memoryHelp())
		return 0
	}
	if args[0] == "sync-repo" {
		for _, arg := range args[1:] {
			if arg == "--help" || arg == "-h" {
				fmt.Fprint(stdout, memoryHelp())
				return 0
			}
		}
	}
	if args[0] != "sync-repo" {
		fmt.Fprint(stderr, memoryHelp())
		return 2
	}
	options, err := parseMemorySyncRepoFlags(args[1:])
	if err != nil {
		fmt.Fprintf(stderr, "pocketctl memory sync-repo: %v\n", err)
		return 2
	}

	ctx := context.WithValue(context.Background(), memorySyncContextKey{}, options)
	snapshot, err := deps.collect(ctx, options.RepoPath)
	if err != nil {
		fmt.Fprintf(stderr, "pocketctl memory sync-repo: %v\n", boundedCollectError(err))
		if strings.HasPrefix(err.Error(), "dirty_") {
			fmt.Fprintln(stderr, "Commit changes first, or use --committed to sync only committed HEAD. See pocketctl memory sync-repo --help.")
		}
		return 1
	}

	fmt.Fprintf(stdout, "repository: %s\n", snapshot.RepositoryKey)
	fmt.Fprintf(stdout, "commit: %s (%s)\n", snapshot.CommitSHA, snapshot.GitObjectFormat)
	fmt.Fprintf(stdout, "manifest_sha256: %s\n", snapshot.ManifestSHA256)
	fmt.Fprintf(stdout, "accepted: %d\n", len(snapshot.Entries))
	fmt.Fprintf(stdout, "total_bytes: %d\n", snapshot.TotalBytes)
	fmt.Fprintf(stdout, "excluded: %d\n", len(snapshot.Excluded))
	reasonCounts := map[string]int{}
	for _, exclusion := range snapshot.Excluded {
		reasonCounts[exclusion.Reason]++
		fmt.Fprintf(stdout, "  - %s: %s\n", exclusion.Path, exclusion.Reason)
	}
	if len(reasonCounts) > 0 {
		fmt.Fprint(stdout, "reasons:")
		for _, reason := range sortedReasonKeys(reasonCounts) {
			fmt.Fprintf(stdout, " %s=%d", reason, reasonCounts[reason])
		}
		fmt.Fprintln(stdout)
	}

	truncated := reasonCounts["too_many_files"] > 0 || reasonCounts["oversized_total"] > 0
	if truncated {
		fmt.Fprintln(stderr, "warning: selection truncated; use --include or a committed .pocketctlmemoryignore, or explicitly --allow-partial")
	}
	if options.DryRun {
		fmt.Fprintln(stdout, "dry-run: nothing uploaded")
		return 0
	}

	if truncated && !options.AllowPartial {
		fmt.Fprintln(stderr, "pocketctl memory sync-repo: partial_snapshot_requires_consent (nothing uploaded)")
		return 1
	}
	if len(snapshot.Entries) == 0 && !options.AllowEmpty {
		fmt.Fprintln(stderr, "pocketctl memory sync-repo: empty_selection (nothing uploaded; use --allow-empty to publish an empty graph)")
		return 1
	}
	result, err := deps.upload(ctx, snapshot)
	if err != nil {
		fmt.Fprintf(stderr, "pocketctl memory sync-repo: upload failed: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "repository_id: %s\nsnapshot_id: %s\nstate: %s\nuploaded_files: %d\nuploaded_bytes: %d\nreused_files: %d\n", result.Repository, result.SnapshotID, result.State, result.UploadedFiles, result.UploadedBytes, result.ReusedFiles)
	if options.ScopeInstallationID != "" {
		fmt.Fprintf(stdout, "scope_installation_id: %s\n", options.ScopeInstallationID)
	}
	if result.ViewURL != "" {
		fmt.Fprintf(stdout, "view_url: %s\n", result.ViewURL)
	}
	fmt.Fprintln(stdout, "Open Web Memory → Code Graph, select the same scope/repository, and refresh after Worker parsing.")
	return 0
}

func boundedCollectError(err error) string {
	message := err.Error()
	if len(message) > 200 {
		message = message[:200]
	}
	return message
}

func sortedReasonKeys(counts map[string]int) []string {
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

func idempotencyKeyFor(snapshot *memorysync.Snapshot) string {
	return fmt.Sprintf("codegraph:%x", sha256.Sum256([]byte(snapshot.RepositoryKey+"@"+snapshot.CommitSHA+":"+snapshot.ManifestSHA256)))
}

// cmdMemory dispatches the `pocketctl memory` subcommands.
func cmdMemory(args []string) {
	os.Exit(runMemorySyncRepo(os.Stdout, os.Stderr, args))
}

func memoryCodeGraphViewURL(relayURL, repositoryID, scopeID string) string {
	view, err := url.Parse(relayURL)
	if err != nil || view.Host == "" {
		return ""
	}
	switch view.Scheme {
	case "wss":
		view.Scheme = "https"
	case "ws":
		view.Scheme = "http"
	case "http", "https":
	default:
		return ""
	}
	view.User = nil
	view.Path = "/app/memory"
	view.RawPath = ""
	view.Fragment = ""
	query := url.Values{"tab": {"codegraph"}, "repository_id": {repositoryID}}
	if scopeID != "" {
		query.Set("installation_id", scopeID)
	}
	view.RawQuery = query.Encode()
	return view.String()
}
