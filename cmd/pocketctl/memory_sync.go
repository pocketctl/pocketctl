package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"regexp"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/memorysync"
)

// memorySyncDeps seams the command for tests; production wires Relay/Memory.
type memorySyncDeps struct {
	collect func(ctx context.Context, repoPath string) (*memorysync.Snapshot, error)
	upload  func(ctx context.Context, snapshot *memorysync.Snapshot) (string, error)
}

// memorySyncRepoOptions is the parsed `pocketctl memory sync-repo` surface.
type memorySyncRepoOptions struct {
	RepoPath             string
	ScopeInstallationID string
	DryRun               bool
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
			return memorysync.Collect(ctx, repoPath, memorysync.DefaultLimits())
		},
		upload: func(ctx context.Context, snapshot *memorysync.Snapshot) (string, error) {
			relayURL, accessToken, _, err := config.LoadAuth()
			if err != nil || relayURL == "" || accessToken == "" {
				return "", fmt.Errorf("not_logged_in")
			}
			options := memorySyncRepoOptionsFromContext(ctx)
			grantClient := memorysync.NewGrantClient(relayURL, accessToken, nil)
			scopeID := options.ScopeInstallationID
			grantSource := memorysync.GrantSourceFunc(func(ctx context.Context, _ string) (memorysync.Grant, error) {
				return grantClient.CodegraphGrant(ctx, scopeID)
			})
			client := memorysync.NewUploadClient(memorysync.UploadClientOptions{
				GrantSource: grantSource,
			})
			result, err := client.SyncSnapshot(ctx, idempotencyKeyFor(snapshot), snapshot)
			if err != nil {
				return "", err
			}
			return result.SnapshotID, nil
		},
	})
}

type memorySyncContextKey struct{}

func memorySyncRepoOptionsFromContext(ctx context.Context) memorySyncRepoOptions {
	options, _ := ctx.Value(memorySyncContextKey{}).(memorySyncRepoOptions)
	return options
}

func runMemorySyncRepoWith(stdout, stderr io.Writer, args []string, deps memorySyncDeps) int {
	if len(args) == 0 || args[0] != "sync-repo" {
		fmt.Fprintln(stderr, "usage: pocketctl memory sync-repo --repo <path> [--scope-installation-id <uuid>] [--dry-run]")
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

	if options.DryRun {
		fmt.Fprintln(stdout, "dry-run: nothing uploaded")
		return 0
	}

	snapshotID, err := deps.upload(ctx, snapshot)
	if err != nil {
		fmt.Fprintf(stderr, "pocketctl memory sync-repo: upload failed: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "snapshot_id: %s\n", snapshotID)
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
	return snapshot.RepositoryKey + "@" + snapshot.CommitSHA + ":" + snapshot.ManifestSHA256
}

// cmdMemory dispatches the `pocketctl memory` subcommands.
func cmdMemory(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: pocketctl memory sync-repo --repo <path> [--scope-installation-id <uuid>] [--dry-run]")
		os.Exit(1)
		return
	}
	switch args[0] {
	case "sync-repo":
		os.Exit(runMemorySyncRepo(os.Stdout, os.Stderr, args))
	default:
		fmt.Fprintf(os.Stderr, "pocketctl: unknown memory command %q\n", args[0])
		os.Exit(2)
	}
}
