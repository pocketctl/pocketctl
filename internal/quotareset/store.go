// Package quotareset journals explicit account operations before sending them.
// An uncertain request never authorizes a second redemption with a new key.
package quotareset

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

type Result struct {
	Kind    string `json:"kind"`
	ScopeID string `json:"scope_id"`
	Outcome string `json:"outcome"`
}
type record struct {
	Type    string `json:"type"`
	Outcome string `json:"outcome"`
}
type journal struct {
	Pending    string            `json:"pending"`
	Operations map[string]record `json:"operations"`
}
type Store struct {
	root string
	mu   sync.Mutex
}

func New(root string) *Store { return &Store{root: root} }

var keyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

func ValidKey(key string) bool { return keyPattern.MatchString(key) }
func (s *Store) path(scope string) string {
	sum := sha256.Sum256([]byte(scope))
	return filepath.Join(s.root, hex.EncodeToString(sum[:])+".json")
}
func (s *Store) load(scope string) (journal, error) {
	j := journal{Operations: map[string]record{}}
	b, err := os.ReadFile(s.path(scope))
	if os.IsNotExist(err) {
		return j, nil
	}
	if err != nil || len(b) > 1024*1024 {
		return j, errors.New("quota_reset_unavailable")
	}
	if json.Unmarshal(b, &j) != nil || j.Operations == nil {
		return j, errors.New("quota_reset_unavailable")
	}
	return j, nil
}
func (s *Store) save(scope string, j journal) error {
	if err := os.MkdirAll(s.root, 0700); err != nil {
		return errors.New("quota_reset_unavailable")
	}
	b, _ := json.Marshal(j)
	f, err := os.CreateTemp(s.root, ".reset-*")
	if err != nil {
		return errors.New("quota_reset_unavailable")
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	ce := f.Close()
	if err == nil {
		err = ce
	}
	if err == nil {
		err = os.Rename(name, s.path(scope))
	}
	if err != nil {
		return errors.New("quota_reset_unavailable")
	}
	d, e := os.Open(s.root)
	if e != nil {
		return errors.New("quota_reset_unavailable")
	}
	defer d.Close()
	if d.Sync() != nil {
		return errors.New("quota_reset_unavailable")
	}
	return nil
}
func (s *Store) Status(scope, key string) (*Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !ValidKey(key) {
		return nil, errors.New("invalid_request")
	}
	j, e := s.load(scope)
	if e != nil {
		return nil, e
	}
	outcome := "notFound"
	if r, ok := j.Operations[key]; ok {
		outcome = r.Outcome
	}
	return &Result{Kind: "quota_reset", ScopeID: scope, Outcome: outcome}, nil
}
func (s *Store) Do(ctx context.Context, scope, key, kind string, retryUnknown bool, action func() (string, error)) (*Result, error) {
	if !s.mu.TryLock() {
		return nil, errors.New("busy")
	}
	defer s.mu.Unlock()
	if !ValidKey(key) || scope == "" {
		return nil, errors.New("invalid_request")
	}
	if ctx.Err() != nil {
		return nil, errors.New("quota_reset_unavailable")
	}
	j, err := s.load(scope)
	if err != nil {
		return nil, err
	}
	result := func(outcome string) *Result { return &Result{Kind: "quota_reset", ScopeID: scope, Outcome: outcome} }
	if r, ok := j.Operations[key]; ok {
		if r.Type != kind {
			return nil, errors.New("request_id_conflict")
		}
		if r.Outcome != "unknown" || !retryUnknown {
			return result(r.Outcome), nil
		}
	}
	if j.Pending != "" && j.Pending != key {
		return result("unknown"), nil
	}
	if len(j.Operations) >= 1024 {
		return nil, errors.New("quota_reset_unavailable")
	}
	j.Pending = key
	j.Operations[key] = record{kind, "unknown"}
	if err = s.save(scope, j); err != nil {
		return nil, err
	}
	outcome, callErr := action()
	if callErr != nil {
		outcome = "unknown"
	}
	switch outcome {
	case "reset", "alreadyRedeemed", "nothingToReset", "noCredit", "unsupported":
		j.Pending = ""
	default:
		outcome = "unknown"
	}
	j.Operations[key] = record{kind, outcome}
	if err = s.save(scope, j); err != nil {
		return result("unknown"), nil
	}
	return result(outcome), nil
}
