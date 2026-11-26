package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

type codexAdoptionSource struct {
	path, homeID, cwd string
	archived          bool
}

// All candidates originate in configured account directories. Cached entries
// are path hints only; every use rereads the original creation metadata.
func (sm *SessionManager) codexAdoptionSource(id, pinnedHome string) (codexAdoptionSource, string) {
	var src codexAdoptionSource
	sm.mu.RLock()
	ps := sm.sessions[id]
	homeID := ""
	if ps != nil {
		if ps.Agent != adapter.AgentCodex || ps.Source == "observer" {
			sm.mu.RUnlock()
			return src, "unsupported_source"
		}
		homeID = ps.CodexHomeID
	}
	policy := sm.cwdPolicy
	sm.mu.RUnlock()
	if pinnedHome != "" && homeID != "" && pinnedHome != homeID {
		return src, "environment_mismatch"
	}
	if pinnedHome != "" {
		homeID = pinnedHome
	}
	profiles := adapter.CodexHomeProfiles()
	if len(profiles) == 1 && homeID == "" {
		homeID = profiles[0].ID
	}
	homeFound := false
	for _, profile := range profiles {
		if homeID != "" && profile.ID != homeID {
			continue
		}
		homeFound = true
		key := profile.ID + "/" + id
		if hint, ok := sm.adoptionSources.Load(key); ok && homeID != "" {
			cached := hint.(codexAdoptionSource)
			verified, reason := sm.verifyAdoptionRollout(profile, id, cached.path, cached.archived)
			if reason == "" {
				src = verified
				break
			}
			if reason != "source_missing" {
				return src, reason
			}
			sm.adoptionSources.Delete(key)
		}
		for _, bucket := range []string{"sessions", "archived_sessions"} {
			root := filepath.Join(profile.Home, bucket)
			reason := ""
			err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
				if err != nil {
					return err
				}
				if !entry.Type().IsRegular() || !strings.HasPrefix(entry.Name(), "rollout-") || !strings.HasSuffix(entry.Name(), "-"+id+".jsonl") {
					return nil
				}
				var candidate codexAdoptionSource
				candidate, reason = sm.verifyAdoptionRollout(profile, id, path, bucket == "archived_sessions")
				if reason != "" {
					return fs.SkipAll
				}
				if src.path != "" {
					reason = "environment_mismatch"
					return fs.SkipAll
				}
				src = candidate
				return nil
			})
			if reason != "" {
				return codexAdoptionSource{}, reason
			}
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return codexAdoptionSource{}, "unverified"
			}
		}
	}
	if !homeFound && homeID != "" {
		return src, "environment_mismatch"
	}
	if src.path == "" {
		return src, "source_missing"
	}
	sm.adoptionSources.Store(src.homeID+"/"+id, src)
	if policy.Allows(src.cwd) != nil {
		return src, "cwd_not_authorized"
	}
	return src, ""
}

func (sm *SessionManager) verifyAdoptionRollout(profile adapter.CodexHomeProfile, id, path string, archived bool) (codexAdoptionSource, string) {
	var empty codexAdoptionSource
	bucket := "sessions"
	if archived {
		bucket = "archived_sessions"
	}
	root := filepath.Join(profile.Home, bucket)
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return empty, "source_missing"
	}
	if !isSubPath(root, canonical) {
		return empty, "environment_mismatch"
	}
	meta, ok := adapter.ReadCodexRolloutMetadata(canonical)
	if !ok || meta.ID != id {
		return empty, "source_missing"
	}
	if meta.IsSubagent || meta.ThreadSource == "subagent" || (meta.ParentThreadID != "" && meta.ParentThreadID != id) {
		return empty, "subsession"
	}
	if len(meta.NativeSource) > 0 && string(meta.NativeSource) != "null" {
		var label string
		if json.Unmarshal(meta.NativeSource, &label) != nil {
			var source map[string]json.RawMessage
			if json.Unmarshal(meta.NativeSource, &source) == nil && source["subagent"] != nil {
				return empty, "subsession"
			}
			return empty, "unsupported_source"
		}
		if label != "cli" && label != "exec" {
			return empty, "unsupported_source"
		}
	}
	class := adapter.ClassifyCodexOrigin(meta)
	if !class.Classified || class.AgentType != adapter.AgentCodex {
		return empty, "unsupported_source"
	}
	if strings.EqualFold(meta.Originator, "pocketctl") && !sm.codexAdoptionBound(id, profile.ID) {
		return empty, "unsupported_source"
	}
	return codexAdoptionSource{path: canonical, homeID: profile.ID, cwd: meta.Cwd, archived: archived}, ""
}

func (sm *SessionManager) codexAdoptionBound(id, homeID string) bool {
	sm.mu.RLock()
	ps := sm.sessions[id]
	var backend *CodexAppServerBackend
	if ps != nil && ps.Agent == adapter.AgentCodex && ps.Source != "observer" && ps.ControlMode == protocol.ControlManaged && ps.CodexHomeID == homeID && slices.Contains(sm.sessionCapabilitiesLocked(ps), MessageAcceptanceReceiptCapability) {
		backend, _ = ps.Backend.(*CodexAppServerBackend)
	}
	sm.mu.RUnlock()
	if backend == nil || backend.coord == nil {
		return false
	}
	c := backend.coord
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.shuttingDown || c.runtime == nil || c.runtime.Client != backend.client || c.generation != backend.generation {
		return false
	}
	if live, ok := backend.client.(interface{ Done() <-chan struct{} }); ok {
		select {
		case <-live.Done():
			return false
		default:
		}
	}
	c.subscribeMu.Lock()
	defer c.subscribeMu.Unlock()
	_, ok := c.subscribed[id]
	return ok && !c.detachedThreads[id]
}

// Only classify upstream errors whose content proves the specific condition.
// In particular a readable SQLite summary does not identify a missing account.
func codexAdoptionRPCReason(id string, err error) string {
	var rpc *codexapp.RPCError
	if !errors.As(err, &rpc) {
		return "unverified"
	}
	message := strings.ToLower(rpc.Message)
	switch {
	case rpc.Code == -32600 && strings.Contains(message, "thread "+id+" already has an active writer"):
		return "active_writer"
	case strings.Contains(message, "session "+id+" is archived"):
		return "archived"
	case strings.Contains(message, "no rollout found for thread id "+id):
		return "source_missing"
	case strings.Contains(message, "cannot change this thread's model provider"):
		return "provider_mismatch"
	}
	return "unverified"
}

// Scope schema evidence to the live runtime and the actual executable files.
// A launcher overwritten in place or an npm shim pointing to a replacement
// binary cannot reuse an old schema simply because its version is unchanged.
type adoptionBinaryIdentity struct {
	launcher, native os.FileInfo
	executable       string
}

func captureAdoptionBinary(binary, exe string) adoptionBinaryIdentity {
	launcher, _ := os.Stat(binary)
	if exe == "" {
		exe = binary
	}
	native, _ := os.Stat(exe)
	return adoptionBinaryIdentity{launcher, native, exe}
}

func (current adoptionBinaryIdentity) matches(other adoptionBinaryIdentity) bool {
	same := func(a, b os.FileInfo) bool {
		return a != nil && b != nil && a.Mode().IsRegular() && os.SameFile(a, b) && a.Size() == b.Size() && a.ModTime().Equal(b.ModTime())
	}
	return current.executable == other.executable && same(current.launcher, other.launcher) && same(current.native, other.native)
}

func (c *codexCoordinator) cachedAdoptionCapabilities(binary, version string) (agentcontrol.CodexCapabilities, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.shuttingDown || c.runtime == nil || c.runtime.Client == nil || c.binary != binary || c.version != version || !c.runtimeCapabilities.Managed() || c.schemaHash != c.runtimeCapabilities.SchemaHash {
		return agentcontrol.CodexCapabilities{}, false
	}
	identity := captureAdoptionBinary(binary, c.runtime.ProcessExecutable)
	return c.runtimeCapabilities, c.adoptionBinary.matches(identity)
}
func (sm *SessionManager) adoptNativeCodex(parent context.Context, op adoptionOperation, archive func(bool) error) string {
	ctx, release, err := sm.acquireObserverDrive(parent, op.SessionID)
	if err != nil {
		return "unsupported_source"
	}
	defer release()
	id := op.SessionID
	src, reason := sm.codexAdoptionSource(id, op.HomeID)
	if reason != "" {
		return reason
	}
	if op.ArchiveIntent && !op.ArchiveChanged && !src.archived {
		if archive(true) != nil {
			return "unverified"
		}
	}
	if sm.codexAdoptionBound(id, src.homeID) {
		return "managed"
	}
	if src.archived && !op.Unarchive {
		return "archived"
	}
	cfg, err := agentcontrol.LoadConfig()
	if err != nil {
		return "unverified"
	}
	if cfg.Codex.State != agentcontrol.StateEnabled {
		return "managed_disabled"
	}
	p := sm.CodexRuntimeProvider()
	binary, version, err := p.resolve()
	switch {
	case errors.Is(err, agentcontrol.ErrCodexVersionTimeout), errors.Is(err, context.DeadlineExceeded):
		return "probe_timeout"
	case errors.Is(err, agentcontrol.ErrCodexNotFound):
		return "cli_missing"
	case err != nil:
		return "unverified"
	case !agentcontrol.SupportsManagedCodexVersion(version):
		return "cli_unsupported"
	}
	c, _, err := p.coordinatorForHomeID(src.homeID)
	if err != nil {
		return "environment_mismatch"
	}
	caps, cached := c.cachedAdoptionCapabilities(binary, version)
	if !cached {
		caps, err = p.adoptionProbe(ctx, binary, version)
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, agentcontrol.ErrCodexProbeTimeout) {
			return "probe_timeout"
		}
		if errors.Is(err, agentcontrol.ErrCodexCapabilities) || errors.Is(err, agentcontrol.ErrCodexVersionUnsupported) {
			return "cli_unsupported"
		}
		if err != nil {
			return "unverified"
		}
		if !caps.Managed() {
			return "cli_unsupported"
		}
	}
	snapshot, err := c.ensureStarted(ctx, binary, version, caps)
	if errors.Is(err, errCodexRuntimeUpgradeDeferred) {
		return "runtime_busy"
	}
	if err != nil {
		return "unverified"
	}
	client, generation, ok := c.backendClient()
	if !ok || generation != snapshot.Generation {
		return "unverified"
	}
	b := newCodexAppServerBackend(sm, c, client, generation)
	end, err := b.reserveGeneration()
	if err != nil {
		return "unverified"
	}
	defer end()
	lock := c.threadOperationLock(id)
	lock.Lock()
	defer lock.Unlock()
	if ctx.Err() != nil {
		return "unverified"
	}
	if sm.codexAdoptionBound(id, src.homeID) {
		return "managed"
	}
	// A native thread/started notification may precede the RPC result. Suppress
	// automatic discovery/subscription until exact identity and writer proof
	// have been checked and the registry is durable.
	fence := &codexAdoptionFence{}
	c.adopting.Store(id, fence)
	keepFence := false
	defer func() {
		if !keepFence {
			c.adopting.CompareAndDelete(id, fence)
		} else {
			c.adopting.CompareAndSwap(id, fence, true)
		}
	}()
	c.subscribeMu.Lock()
	_, hadSubscription := c.subscribed[id]
	c.subscribeMu.Unlock()
	committed := false
	defer func() {
		if committed || !keepFence || hadSubscription {
			return
		}
		cleanup, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		// Release the requested ID only; an unexpected ID in the response has
		// no local ownership proof and may belong to another client.
		_ = client.Call(cleanup, "thread/unsubscribe", map[string]string{"threadId": id}, nil)
	}()
	wasArchived := src.archived
	var original *adoptionSandboxLimit
	if src.archived {
		// Read the archived limit before the first mutating RPC. Close the file
		// before Codex moves it, including on Windows.
		archived, err := os.Open(src.path)
		if err != nil {
			return "source_missing"
		}
		original = lastAdoptionSandbox(ctx, archived)
		archived.Close()
		if archive(false) != nil {
			return "unverified"
		}
		var result struct{ Thread struct{ ID string } }
		err = client.Call(ctx, "thread/unarchive", map[string]string{"threadId": id}, &result)
		if err == nil {
			keepFence = true
		}
		after, reason := sm.codexAdoptionSource(id, src.homeID)
		if after.path != "" && after.homeID == src.homeID && !after.archived {
			if archive(true) != nil {
				return "unverified"
			}
		}
		if err != nil {
			return codexAdoptionRPCReason(id, err)
		}
		if reason != "" || after.archived || result.Thread.ID != id {
			return "unverified"
		}
		src = after
	}
	var result struct {
		Cwd    string
		Thread struct{ ID, Path string }
		codexNativeConfigFields
	}
	// Ask Codex for the effective provider in this original working directory.
	// Supplying that locally established value lets resume reject a provider
	// switch; it never comes from a client request.
	var config struct {
		Config struct {
			ModelProvider string `json:"model_provider"`
		}
	}
	if err := client.Call(ctx, "config/read", map[string]any{"cwd": src.cwd, "includeLayers": false}, &config); err != nil {
		return "unverified"
	}
	params := map[string]any{"threadId": id, "excludeTurns": true}
	if config.Config.ModelProvider != "" {
		params["modelProvider"] = config.Config.ModelProvider
	}
	file, err := os.Open(src.path)
	if err != nil {
		return "source_missing"
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil {
		return "unverified"
	}
	if err := client.Call(ctx, "thread/resume", params, &result); err != nil {
		return codexAdoptionRPCReason(id, err)
	}
	keepFence = true // a completed but unverifiable resume must not publish via delayed notifications
	if result.Thread.ID != id {
		return "unverified"
	}
	path, err := filepath.EvalSymlinks(result.Thread.Path)
	if err != nil || path != src.path {
		return "unverified"
	}
	sm.mu.RLock()
	cwdPolicy, remotePolicy := sm.cwdPolicy, sm.remotePermission
	sm.mu.RUnlock()
	if result.Cwd == "" || cwdPolicy.Allows(result.Cwd) != nil {
		return "cwd_not_authorized"
	}
	now, err := os.Stat(path)
	if err != nil || !os.SameFile(before, now) {
		return "unverified"
	}
	// Inspect the original pre-resume bytes only after native confirms a writer.
	// Waiting on a lock never rescans the thread's conversation history.
	if !wasArchived {
		original = lastAdoptionSandbox(ctx, io.NewSectionReader(file, 0, before.Size()))
	}
	permission := adoptedNativePermission(result.codexNativeConfigFields)
	if original == nil || original.Approval == "" || original.Sandbox.Type == "" || permission == nil {
		return "unverified"
	}
	if !original.allows(permission, result.Cwd, result.codexNativeConfigFields) || adapter.ValidateRemotePermissionConfigWithPolicy(adapter.AgentCodex, permission, remotePolicy) != nil {
		return "permission_denied"
	}
	after, reason := sm.codexAdoptionSource(id, src.homeID)
	if reason != "" {
		return reason
	}
	if after.path != src.path || after.archived {
		return "unverified"
	}
	c.mu.Lock()
	if c.shuttingDown || c.runtime == nil || c.runtime.Client != client || c.generation != generation {
		c.mu.Unlock()
		return "unverified"
	}
	sm.mu.Lock()
	ps := sm.sessions[id]
	if ps != nil && (ps.Agent != adapter.AgentCodex || ps.Source == "observer") {
		sm.mu.Unlock()
		c.mu.Unlock()
		return "unsupported_source"
	}
	// Persist only the shared runtime handoff. The account-scoped operation
	// is already durable and exclusively owns recovery of this specific ID.
	_, alreadyAdopted := c.adoptedThreads.LoadOrStore(id, true)
	if err := c.persistLocked(); err != nil {
		if !alreadyAdopted {
			c.adoptedThreads.Delete(id)
		}
		sm.mu.Unlock()
		c.mu.Unlock()
		return "unverified"
	}
	c.subscribeMu.Lock()
	c.managedThreads[id] = struct{}{}
	c.subscribed[id] = struct{}{}
	delete(c.detachedThreads, id)
	c.threadStateVersion++
	c.subscribeMu.Unlock()
	if ps == nil {
		ps = &ProcessState{SessionID: id, StartedAt: time.Now(), Agent: adapter.AgentCodex, Source: "terminal", Status: protocol.StatusIdle}
		sm.sessions[id] = ps
	}
	c.registerProjectedCwdLocked(id, ps.Cwd, result.Cwd)
	// Historical loading uses creation defaults. Never replay those as overrides
	// on an original native thread (including custom sandbox writable roots).
	if ps.CodexNativePermission == nil {
		ps.Permission = nil
	}
	ps.CodexNativePermission = permission
	ps.Cwd = result.Cwd
	ps.Backend = b
	ps.ControlMode = protocol.ControlManaged
	ps.CodexHomeID, ps.CodexHomeLabel = c.codexHomeID, c.codexHomeLabel
	if result.Model != "" {
		ps.Model = result.Model
	}
	if ps.Status == protocol.StatusDisconnected || ps.Status == protocol.StatusKilled || ps.Status == protocol.StatusExited || ps.Status == protocol.StatusCompleted {
		ps.Status = protocol.StatusIdle
	}
	event := protocol.DaemonEvent{Type: "session_discovered", SessionID: id, Agent: ps.Agent, Source: ps.Source, Status: ps.Status, Cwd: ps.Cwd, Model: ps.Model, Resync: true}
	sm.mu.Unlock()
	c.mu.Unlock()
	committed = true
	keepFence = false
	c.adopting.CompareAndDelete(id, fence)
	fence.release()
	sm.rememberNativeCodexConfig(id, result.codexNativeConfigFields)
	if sm.OnStateChanged != nil {
		sm.OnStateChanged()
	}
	event = sm.codexSessionMetadata(event)
	select {
	case sm.outputCh <- event:
	case <-ctx.Done(): // Registry remains committed. Ordinary session resync republishes metadata.
	}
	if !sm.codexAdoptionBound(id, src.homeID) {
		return "unverified"
	}
	return "managed"
}

func adoptedNativePermission(value codexNativeConfigFields) *protocol.PermissionConfig {
	var approval string
	if json.Unmarshal(value.ApprovalPolicy, &approval) != nil || approval == "" {
		return nil
	}
	p := &protocol.PermissionConfig{Agent: adapter.AgentCodex, Preset: "custom", ApprovalPolicy: approval}
	switch value.Sandbox.Type {
	case "readOnly":
		p.SandboxMode = "read-only"
	case "workspaceWrite":
		p.SandboxMode = "workspace-write"
	case "dangerFullAccess":
		p.SandboxMode = "danger-full-access"
	default:
		return nil
	}
	return p
}

type adoptionPendingRequest struct {
	request codexapp.Inbound
	broker  *codexInteractions
}
type codexAdoptionFence struct {
	mu       sync.Mutex
	released bool
	pending  []adoptionPendingRequest
}

func (f *codexAdoptionFence) hold(request codexapp.Inbound, broker *codexInteractions) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.released {
		return false
	}
	if broker != nil {
		f.pending = append(f.pending, adoptionPendingRequest{request, broker})
	}
	return true
}
func (f *codexAdoptionFence) release() {
	f.mu.Lock()
	f.released = true
	pending := f.pending
	f.pending = nil
	f.mu.Unlock()
	for _, p := range pending {
		p.broker.Handle(p.request)
	}
}

// Ordinary sends after native idle detach and the explicit resume entry point
// share the original admission contract. Renewing a writer never conveys
// consent for a later, independently archived session.
func (b *CodexAppServerBackend) resumeAdoptedCodex(parent context.Context, id string) error {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	op := adoptionOperation{AdoptionReceipt: protocol.AdoptionReceipt{SessionID: id}, HomeID: b.coord.codexHomeID}
	reason := b.sm.adoptNativeCodex(ctx, op, nil)
	s := b.sm.adoptionService()
	s.mu.Lock()
	latest := s.latestLocked(id)
	if latest.OperationID != "" && (latest.Phase == "managed" || latest.Phase == "failed" && latest.Reason == "unverified") && latest.Reason != reason {
		phase := "blocked"
		if reason == "managed" {
			phase = "managed"
		} else if reason == "unverified" {
			phase = "failed"
		}
		setAdoptionState(&latest.AdoptionReceipt, phase, reason)
		latest.Revision++
		if err := s.saveLocked(latest); err != nil {
			s.failures[latest.OperationID] = err
		}
	}
	s.mu.Unlock()
	if reason == "managed" {
		return nil
	}
	b.sm.revokeCodexAdoption(ctx, b.coord, id, b.generation)
	return fmt.Errorf("Codex adoption: %s", reason)
}
