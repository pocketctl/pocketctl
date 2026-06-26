package session

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
)

// worktreeSuffix is the short id length used in branch names and paths.
const worktreeSuffixLen = 8

// createWorktree runs `git worktree add` inside repoRoot to create an isolated
// working tree at <repoRoot>/.pocketctl/wt-<shortSID> on a new branch
// pocketctl/<shortSID>. It returns the absolute worktree path and branch name.
//
// The worktree is intentionally kept after the session exits (Scheme D decision:
// never lose uncommitted work); cleanup is left to the user via git directly.
func createWorktree(repoRoot, sessionID string) (worktreePath, branch string, err error) {
	if len(sessionID) < worktreeSuffixLen {
		return "", "", fmt.Errorf("git worktree: session id too short")
	}
	short := sessionID[:worktreeSuffixLen]
	branch = "pocketctl/" + short
	worktreePath = filepath.Join(repoRoot, ".pocketctl", "wt-"+short)

	// `git worktree add -b <branch> <path> HEAD` — fails if branch/path exists,
	// which is what we want (a collision means a duplicate session id).
	cmd := exec.Command("git", "worktree", "add", "-b", branch, worktreePath, "HEAD")
	cmd.Dir = repoRoot
	if out, runErr := cmd.CombinedOutput(); runErr != nil {
		return "", "", fmt.Errorf("git worktree add failed: %s: %w", strings.TrimSpace(string(out)), runErr)
	}
	return worktreePath, branch, nil
}
