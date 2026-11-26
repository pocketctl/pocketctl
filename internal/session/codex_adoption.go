package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"math/rand/v2"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Each operation is replaced atomically, including all joining request IDs.
// The directory is private to the daemon's OS user. HomeID pins the original
// authorized account even when the directory allowlist changes after restart.
type adoptionOperation struct {
	protocol.AdoptionReceipt
	HomeID        string    `json:"home_id,omitempty"`
	Created       time.Time `json:"created"`
	Requests      []string  `json:"requests"`
	Unarchive     bool      `json:"unarchive"`
	ArchiveIntent bool      `json:"archive_intent"`
}

type adoptionRequestKey struct{ session, request string }

type codexAdoptionService struct {
	sm         *SessionManager
	dir        string
	ctx        context.Context
	cancel     context.CancelFunc
	mu         sync.Mutex
	wg         sync.WaitGroup
	loaded     bool
	operations map[string]adoptionOperation
	latest     map[string]string
	requests   map[adoptionRequestKey]string
	workers    map[string]bool
	failures   map[string]error
	attempt    func(context.Context, adoptionOperation, func(bool) error) string
}

// SetCodexAdoptionOwner is called once with the authenticated startup identity,
// before starting either transport or recovering the native runtime.
func (sm *SessionManager) SetCodexAdoptionOwner(account, daemonID string) {
	digest := sha256.Sum256([]byte(account + "\x00" + daemonID))
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.adoptionOwner = hex.EncodeToString(digest[:])
}

func (sm *SessionManager) adoptionService() *codexAdoptionService {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if sm.adoptions == nil {
		ctx, cancel := context.WithCancel(context.Background())
		s := &codexAdoptionService{sm: sm, dir: filepath.Join(filepath.Dir(daemon.CodexAppServerStatePath()), "codex-adoptions", sm.adoptionOwner), ctx: ctx, cancel: cancel, operations: map[string]adoptionOperation{}, latest: map[string]string{}, requests: map[adoptionRequestKey]string{}, workers: map[string]bool{}, failures: map[string]error{}}
		s.attempt = sm.adoptNativeCodex
		sm.adoptions = s
	}
	return sm.adoptions
}

func (s *codexAdoptionService) stop() {
	s.mu.Lock()
	s.cancel()
	s.mu.Unlock()
	s.wg.Wait()
}

func validAdoptionID(id string) bool {
	u, err := uuid.Parse(id)
	return err == nil && u.String() == id && u != uuid.Nil
}

func (s *codexAdoptionService) loadLocked() error {
	if s.loaded {
		return nil
	}
	entries, err := os.ReadDir(s.dir)
	if errors.Is(err, os.ErrNotExist) {
		s.loaded = true
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		if !entry.Type().IsRegular() {
			return errors.New("invalid Codex adoption journal file")
		}
		file := filepath.Join(s.dir, entry.Name())
		var op adoptionOperation
		data, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		if json.Unmarshal(data, &op) != nil || !validAdoptionID(op.SessionID) || !validAdoptionID(op.OperationID) || op.OperationID+".json" != filepath.Base(file) || op.Version != 1 {
			return errors.New("invalid Codex adoption journal")
		}
		s.indexLocked(op)
	}
	s.loaded = true
	return nil
}

func (s *codexAdoptionService) saveLocked(op adoptionOperation) error {
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return err
	}
	data, err := json.Marshal(op)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(s.dir, ".pending-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	if err := os.Rename(f.Name(), filepath.Join(s.dir, op.OperationID+".json")); err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		dir, err := os.Open(s.dir)
		if err != nil {
			return err
		}
		if err = errors.Join(dir.Sync(), dir.Close()); err != nil {
			return err
		}
	}
	s.indexLocked(op)
	delete(s.failures, op.OperationID)
	return nil
}

func (s *codexAdoptionService) latestLocked(id string) adoptionOperation {
	return s.operations[s.latest[id]]
}
func (s *codexAdoptionService) indexLocked(op adoptionOperation) {
	prev := s.operations[op.OperationID]
	s.operations[op.OperationID] = op
	if latest := s.operations[s.latest[op.SessionID]]; latest.OperationID == "" || op.Created.After(latest.Created) {
		s.latest[op.SessionID] = op.OperationID
	}
	for _, r := range op.Requests[len(prev.Requests):] {
		s.requests[adoptionRequestKey{op.SessionID, r}] = op.OperationID
	}
}

func adoptionActive(phase string) bool {
	return phase == "checking" || phase == "waiting" || phase == "binding"
}

func setAdoptionState(r *protocol.AdoptionReceipt, phase, reason string) {
	r.Phase, r.Reason = phase, reason
	r.AllowedActions = []string{}
	r.LocalManaged = phase == "managed"
	r.Retryable = false
	r.RetryAfterMS = 0
	switch {
	case phase == "waiting":
		r.AllowedActions = []string{"cancel"}
	case phase == "available" || phase == "cancelled" || phase == "expired":
		r.Retryable = true
		r.AllowedActions = []string{"adopt"}
	case reason == "active_writer":
		r.Retryable = true
		r.AllowedActions = []string{"wait", "adopt"}
	case reason == "cli_missing" || reason == "cli_unsupported" || reason == "permission_denied":
		r.Retryable = true
		r.AllowedActions = []string{"adopt"}
	case reason == "archived":
		r.AllowedActions = []string{"unarchive"}
	case reason == "unverified" || reason == "probe_timeout" || reason == "runtime_busy" || reason == "provider_mismatch" || reason == "environment_mismatch" || reason == "source_missing":
		r.Retryable = true
		if reason != "source_missing" && reason != "environment_mismatch" {
			r.AllowedActions = []string{"adopt"}
		}
	}
}

func (s *codexAdoptionService) recover() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return err
	}
	for _, op := range s.operations {
		if s.latestLocked(op.SessionID).OperationID != op.OperationID {
			continue
		}
		if op.Phase == "managed" {
			op.Deadline = nil    // the original acquisition completed before its deadline
			op.Unarchive = false // a later independent archive requires fresh consent
			setAdoptionState(&op.AdoptionReceipt, "checking", "")
			op.Revision++
			if err := s.saveLocked(op); err != nil {
				return err
			}
		}
		if adoptionActive(op.Phase) {
			s.startWorkerLocked(op.OperationID)
		}
	}
	return nil
}

func (sm *SessionManager) AdoptCodex(ctx context.Context, req protocol.AdoptionRequest) (protocol.AdoptionReceipt, error) {
	var empty protocol.AdoptionReceipt
	if !validAdoptionID(req.SessionID) || req.RequestID == "" || len(req.RequestID) > 256 || req.OperationID != "" || req.WaitMS < 0 || req.WaitMS > 120000 {
		return empty, errors.New("invalid Codex adoption request")
	}
	if err := ctx.Err(); err != nil {
		return empty, err
	}
	s := sm.adoptionService()
	// Read the source before recording consent or choosing a runtime. Re-check
	// inside every binding attempt. No file path comes from the caller.
	src, reason := sm.codexAdoptionSource(req.SessionID, "")
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return empty, err
	}
	if err := s.ctx.Err(); err != nil {
		return empty, err
	}
	if id := s.requests[adoptionRequestKey{req.SessionID, req.RequestID}]; id != "" {
		return s.receiptLocked(s.operations[id])
	}
	op := s.latestLocked(req.SessionID)
	if adoptionActive(op.Phase) {
		op.Requests = append(slices.Clone(op.Requests), req.RequestID)
		if err := s.saveLocked(op); err != nil {
			return empty, err
		}
		return s.receiptLocked(op)
	}
	now := time.Now().UTC()
	op = adoptionOperation{AdoptionReceipt: protocol.AdoptionReceipt{Version: 1, SessionID: req.SessionID, OperationID: uuid.NewString(), Revision: 1}, Created: now, Requests: []string{req.RequestID}, HomeID: src.homeID, Unarchive: req.Unarchive}
	if req.WaitMS > 0 {
		d := now.Add(time.Duration(req.WaitMS) * time.Millisecond)
		op.Deadline = &d
	}
	setAdoptionState(&op.AdoptionReceipt, "checking", "")
	if reason != "" {
		setAdoptionState(&op.AdoptionReceipt, "blocked", reason)
	}
	if err := s.saveLocked(op); err != nil {
		return empty, err
	}
	if adoptionActive(op.Phase) {
		s.startWorkerLocked(op.OperationID)
	}
	return op.AdoptionReceipt, nil
}

func (s *codexAdoptionService) receiptLocked(op adoptionOperation) (protocol.AdoptionReceipt, error) {
	if err := s.failures[op.OperationID]; err != nil {
		return protocol.AdoptionReceipt{}, err
	}
	r := op.AdoptionReceipt
	if r.LocalManaged && !s.sm.codexAdoptionBound(op.SessionID, op.HomeID) {
		setAdoptionState(&r, "failed", "unverified")
		// Persist the revocation so it participates in revision ordering.
		r.Revision++
		op.AdoptionReceipt = r
		if err := s.saveLocked(op); err != nil {
			return protocol.AdoptionReceipt{}, err
		}
	}
	return r, nil
}

func (sm *SessionManager) CodexAdoptionStatus(ctx context.Context, id, operation string) (protocol.AdoptionReceipt, error) {
	var empty protocol.AdoptionReceipt
	if !validAdoptionID(id) {
		return empty, errors.New("invalid session ID")
	}
	if err := ctx.Err(); err != nil {
		return empty, err
	}
	s := sm.adoptionService()
	s.mu.Lock()
	if err := s.loadLocked(); err != nil {
		s.mu.Unlock()
		return empty, err
	}
	op := s.latestLocked(id)
	if operation != "" {
		op = s.operations[operation]
		if op.SessionID != id {
			s.mu.Unlock()
			return empty, protocol.ErrAdoptionOperationNotFound
		}
	}
	if op.ArchiveIntent && !op.ArchiveChanged {
		s.mu.Unlock()
		original, _ := sm.codexAdoptionSource(id, op.HomeID)
		s.mu.Lock()
		op = s.operations[op.OperationID]
		if original.path != "" && !original.archived && original.homeID == op.HomeID && !op.ArchiveChanged {
			op.ArchiveChanged = true
			op.Revision++
			if err := s.saveLocked(op); err != nil {
				s.mu.Unlock()
				return empty, err
			}
		}
	}
	if op.OperationID != "" {
		receipt, err := s.receiptLocked(op)
		s.mu.Unlock()
		if operation != "" || err != nil || receipt.Phase != "blocked" {
			return receipt, err
		}
		// A historical receipt is immutable when requested by operation ID. An
		// unqualified status is also discovery: recheck operator-fixable causes.
		switch receipt.Reason {
		case "source_missing", "unsupported_source", "subsession", "environment_mismatch", "cwd_not_authorized", "managed_disabled", "archived":
			current := sm.codexAdoptionAvailability(id)
			if current.Phase == "available" || current.Phase == "managed" || current.Reason != receipt.Reason {
				return current, nil
			}

		}
		return receipt, nil
	}
	s.mu.Unlock()
	return sm.codexAdoptionAvailability(id), nil
}

func (sm *SessionManager) codexAdoptionAvailability(id string) protocol.AdoptionReceipt {
	src, reason := sm.codexAdoptionSource(id, "")
	r := protocol.AdoptionReceipt{Version: 1, SessionID: id}
	cfg, err := agentcontrol.LoadConfig()
	switch {
	case reason != "":
		setAdoptionState(&r, "blocked", reason)
	case sm.codexAdoptionBound(id, src.homeID):
		setAdoptionState(&r, "managed", "managed")
	case err != nil:
		setAdoptionState(&r, "failed", "unverified")
	case cfg.Codex.State != agentcontrol.StateEnabled:
		setAdoptionState(&r, "blocked", "managed_disabled")
	case src.archived:
		setAdoptionState(&r, "blocked", "archived")
	default:
		setAdoptionState(&r, "available", "eligible")
	}
	return r
}

func (sm *SessionManager) CancelCodexAdoption(ctx context.Context, id, operation string) (protocol.AdoptionReceipt, error) {
	s := sm.adoptionService()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return protocol.AdoptionReceipt{}, err
	}
	if err := s.loadLocked(); err != nil {
		return protocol.AdoptionReceipt{}, err
	}
	op, ok := s.operations[operation]
	if !ok || op.SessionID != id {
		return protocol.AdoptionReceipt{}, protocol.ErrAdoptionOperationNotFound
	}
	if op.Phase == "waiting" {
		setAdoptionState(&op.AdoptionReceipt, "cancelled", "cancelled")
		op.Revision++
		if err := s.saveLocked(op); err != nil {
			return protocol.AdoptionReceipt{}, err
		}
	}
	return s.receiptLocked(op)
}

func (s *codexAdoptionService) startWorkerLocked(id string) {
	if s.workers[id] || s.ctx.Err() != nil {
		return
	}
	s.workers[id] = true
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		err := s.run(id)
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(s.workers, id)
		if err != nil && s.ctx.Err() == nil {
			s.failures[id] = err
			slog.Error("Codex adoption persistence failed", "operation", id, "error", err)
		} else if adoptionActive(s.operations[id].Phase) && s.ctx.Err() == nil {
			// Reconnection may have requested revalidation after the final receipt
			// but before this goroutine relinquished its worker slot.
			s.startWorkerLocked(id)

		}
	}()
}

func (s *codexAdoptionService) run(id string) error {
	backoff := time.Second
	for s.ctx.Err() == nil {
		s.mu.Lock()
		op := s.operations[id]
		if !adoptionActive(op.Phase) {
			s.mu.Unlock()
			return nil
		}
		if op.Deadline != nil && !time.Now().Before(*op.Deadline) {
			if op.ArchiveIntent && !op.ArchiveChanged {
				s.mu.Unlock()
				src, reason := s.sm.codexAdoptionSource(op.SessionID, op.HomeID)
				s.mu.Lock()
				op = s.operations[id]
				if !adoptionActive(op.Phase) {
					s.mu.Unlock()
					return nil
				}
				op.ArchiveChanged = reason == "" && !src.archived
			}
			setAdoptionState(&op.AdoptionReceipt, "expired", "deadline_exceeded")
			op.Revision++
			err := s.saveLocked(op)
			s.mu.Unlock()
			return err
		}
		setAdoptionState(&op.AdoptionReceipt, "binding", "")
		op.Revision++
		err := s.saveLocked(op)
		s.mu.Unlock()
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
		if op.Deadline != nil {
			var end context.CancelFunc
			ctx, end = context.WithDeadline(ctx, *op.Deadline)
			old := cancel
			cancel = func() { end(); old() }
		}
		var saveErr error
		reason := s.attempt(ctx, op, func(changed bool) error {
			s.mu.Lock()
			defer s.mu.Unlock()
			current := s.operations[id]
			current.ArchiveIntent = true
			if changed {
				current.ArchiveChanged = true
			}
			current.Revision++
			saveErr = s.saveLocked(current)
			return saveErr
		})
		cancel()
		if saveErr != nil {
			return saveErr
		}
		if s.ctx.Err() != nil {
			return nil
		}
		s.mu.Lock()
		op = s.operations[id]
		delay := backoff - time.Duration(rand.Int64N(int64(backoff/8)))
		switch {
		case reason == "managed":
			setAdoptionState(&op.AdoptionReceipt, "managed", "managed")
		case op.Deadline != nil && time.Until(*op.Deadline) <= 0:
			setAdoptionState(&op.AdoptionReceipt, "expired", "deadline_exceeded")
		case reason == "active_writer" && op.Deadline != nil:
			setAdoptionState(&op.AdoptionReceipt, "waiting", reason)
			delay = min(delay, time.Until(*op.Deadline))
			op.RetryAfterMS = max(int64(1), delay.Milliseconds())
		case reason == "unverified":
			setAdoptionState(&op.AdoptionReceipt, "failed", reason)
		default:
			setAdoptionState(&op.AdoptionReceipt, "blocked", reason)
		}
		op.Revision++
		err = s.saveLocked(op)
		s.mu.Unlock()
		if err != nil || op.Phase != "waiting" {
			return err
		}
		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-s.ctx.Done():
			timer.Stop()
			return nil
		}
		backoff = min(2*backoff, 8*time.Second)
	}
	return nil
}

// A disconnected daemon client immediately loses its writable proof. The
// next client must complete the same scoped transaction before re-enabling it.
func (sm *SessionManager) revokeCodexAdoption(ctx context.Context, c *codexCoordinator, id string, generation uint64) {
	sm.mu.Lock()
	ps := sm.sessions[id]
	if ps == nil {
		sm.mu.Unlock()
		return
	}
	backend, ok := ps.Backend.(*CodexAppServerBackend)
	if !ok || backend.coord != c || backend.generation != generation {
		sm.mu.Unlock()
		return
	}
	ps.Backend = nil
	ps.ControlMode = protocol.ControlLegacyReadOnly
	sm.mu.Unlock()
	event := sm.codexSessionMetadata(protocol.DaemonEvent{Type: "session_meta", SessionID: id, Resync: true})
	select {
	case sm.outputCh <- event:
	case <-ctx.Done():
	}
}

func (sm *SessionManager) recheckCodexAdoption(ctx context.Context, id string) {
	s := sm.adoptionService()
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx.Err() != nil || s.ctx.Err() != nil {
		return
	}
	op := s.latestLocked(id)
	if op.OperationID == "" || adoptionActive(op.Phase) {
		return
	}
	if op.Phase != "managed" && !(op.Phase == "failed" && op.Reason == "unverified") {
		return
	}
	op.Deadline = nil
	op.Unarchive = false
	op.Revision++
	setAdoptionState(&op.AdoptionReceipt, "checking", "")
	if err := s.saveLocked(op); err != nil {
		s.failures[op.OperationID] = err
		return
	}
	s.startWorkerLocked(op.OperationID)
}
