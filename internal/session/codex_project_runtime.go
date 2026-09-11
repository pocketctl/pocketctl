package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/daemon"
)

// Project runtimes own new remote-created threads. Legacy/terminal runtimes are
// never reconfigured or force-migrated to opt an existing thread into skills.
var projectGeneration atomic.Uint64

func (c *codexCoordinator) runtimeStatePath() string {
	if c.statePath != "" {
		return c.statePath
	}
	return daemon.CodexAppServerStatePath()
}
func (c *codexCoordinator) readState() (*daemon.CodexAppServerState, error) {
	return daemon.ReadCodexAppServerStateAt(c.runtimeStatePath())
}
func (c *codexCoordinator) removeState() error {
	err := os.Remove(c.runtimeStatePath())
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
func projectRuntimeKey(cwd string) string {
	sum := sha256.Sum256([]byte(cwd))
	return hex.EncodeToString(sum[:16])
}
func projectStateDir() string {
	return filepath.Join(filepath.Dir(daemon.CodexAppServerStatePath()), "codex-project-runtimes")
}
func (p *CodexRuntimeProvider) projectCoordinator(cwd string) (*codexCoordinator, error) {
	canonical, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		return nil, err
	}
	canonical, err = filepath.Abs(canonical)
	if err != nil {
		return nil, err
	}
	key := projectRuntimeKey(canonical)
	p.projectsMu.Lock()
	defer p.projectsMu.Unlock()
	if c := p.projects[key]; c != nil {
		return c, nil
	}
	if len(p.projects) >= 32 {
		return nil, errors.New("Codex project runtime limit reached (32); close unused project runtimes before creating another")
	}
	if p.projects == nil {
		p.projects = make(map[string]*codexCoordinator)
	}
	c := newCodexCoordinator(p.sm)
	c.projectCwd = canonical
	c.statePath = filepath.Join(projectStateDir(), key+".state")
	// Safe JSON integer, distinct from the legacy generation and other projects.
	c.generation = uint64(time.Now().UnixMilli())*1000 + projectGeneration.Add(1)%1000
	p.projects[key] = c
	return c, nil
}
func (p *CodexRuntimeProvider) recoverProjects(ctx context.Context) error {
	cfg, err := agentcontrol.LoadConfig()
	if err != nil {
		return err
	}
	if cfg.Codex.State != agentcontrol.StateEnabled {
		return nil
	}
	files, err := filepath.Glob(filepath.Join(projectStateDir(), "*.state"))
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return nil
	}
	binary, version, err := p.resolve()
	if err != nil {
		return err
	}
	caps, err := p.probe(ctx, binary, version)
	if err != nil {
		return err
	}
	if !caps.Managed() {
		return errors.New("Codex managed capabilities are incomplete")
	}
	var recoveryErrors []error
	for _, file := range files {
		state, err := daemon.ReadCodexAppServerStateAt(file)
		if err != nil {
			recoveryErrors = append(recoveryErrors, fmt.Errorf("%s: %w", filepath.Base(file), err))
			continue
		}
		if state.Cwd == "" || filepath.Base(file) != projectRuntimeKey(state.Cwd)+".state" {
			recoveryErrors = append(recoveryErrors, errors.New("invalid Codex project runtime identity"))
			continue
		}
		coord, err := p.projectCoordinator(state.Cwd)
		if err == nil {
			_, err = coord.ensureStarted(ctx, binary, version, caps)
		}
		if err != nil {
			recoveryErrors = append(recoveryErrors, fmt.Errorf("project %s: %w", filepath.Base(file), err))
		}
	}
	return errors.Join(recoveryErrors...)
}
func (p *CodexRuntimeProvider) shutdownAll() error {
	p.projectsMu.Lock()
	coords := make([]*codexCoordinator, 0, len(p.projects))
	for _, c := range p.projects {
		coords = append(coords, c)
	}
	p.projectsMu.Unlock()
	var errs []error
	for _, c := range coords {
		errs = append(errs, c.shutdown())
	}
	errs = append(errs, p.coordinator.shutdown())
	return errors.Join(errs...)
}

// Extra roots are confined to this cwd's nearest repository. Native global and
// system skills remain native. No project files are copied or rewritten.
func codexProjectSkillRoots(cwd string) ([]string, error) {
	canonical, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		return nil, err
	}
	cwd = canonical
	root := cwd
	for dir := cwd; ; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			root = dir
			break
		}
		if filepath.Dir(dir) == dir {
			break
		}
	}
	var roots []string
	count := 0
	for dir := cwd; ; dir = filepath.Dir(dir) {
		for _, name := range []string{".claude", ".codex"} {
			candidate := filepath.Join(dir, name)
			info, err := os.Stat(candidate)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return nil, err
			}
			if !info.IsDir() {
				continue
			}
			actual, err := filepath.EvalSymlinks(candidate)
			if err != nil {
				return nil, err
			}
			if !withinSkillProject(root, actual) {
				return nil, fmt.Errorf("skill root leaves project: %s", candidate)
			}
			err = filepath.WalkDir(actual, func(path string, entry fs.DirEntry, walkErr error) error {
				if walkErr != nil {
					return walkErr
				}
				count++
				if count > 20000 {
					return errors.New("project skill discovery exceeds 20000 entries")
				}
				rel, _ := filepath.Rel(actual, path)
				if strings.Count(rel, string(filepath.Separator)) > 32 {
					return errors.New("project skill discovery exceeds depth 32")
				}
				if entry.Type()&os.ModeSymlink != 0 {
					target, err := filepath.EvalSymlinks(path)
					if err != nil {
						return err
					}
					info, err := os.Stat(target)
					if err != nil {
						return err
					}
					// WalkDir does not follow directory symlinks, whereas the
					// native loader may. Reject these rather than leaving a
					// nested escape unvalidated.
					if info.IsDir() {
						return fmt.Errorf("skill directory symlink is unsupported: %s", path)
					}
					if !withinSkillProject(root, target) {
						return fmt.Errorf("skill symlink leaves project: %s", path)
					}
				}
				return nil
			})
			if err != nil {
				return nil, err
			}
			roots = append(roots, actual)
		}
		if dir == root || filepath.Dir(dir) == dir {
			break
		}
	}
	return roots, nil
}
func withinSkillProject(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
func (c *codexCoordinator) configureProjectSkills(ctx context.Context, client codexRuntimeClient) error {
	roots, err := codexProjectSkillRoots(c.projectCwd)
	if err != nil {
		return err
	}
	if roots == nil {
		roots = []string{}
	}
	return client.Call(ctx, "skills/extraRoots/set", map[string]any{"extraRoots": roots}, nil)
}
