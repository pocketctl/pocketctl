package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/platform"
)

const (
	StopIntentActive   = "active"
	StopIntentComplete = "complete"
)

type StopIntent struct {
	Token     string    `json:"token"`
	Status    string    `json:"status"`
	UpdatedAt time.Time `json:"updated_at"`
}

func StopIntentPath() string {
	home, _ := config.HomeDir()
	return filepath.Join(home, ".pocketctl", "daemon-stop.intent")
}
func lifecycleLockPath() string { return StopIntentPath() + ".lock" }

var lifecycleLocker = platform.NewLogicalLocker("daemon-lifecycle")

func acquireLifecycleLock() (io.Closer, error) {
	path := lifecycleLockPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	_ = os.Chmod(filepath.Dir(path), 0o700)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		lock, err := lifecycleLocker.Acquire(path)
		if err == nil {
			return lock, nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return nil, fmt.Errorf("timed out acquiring daemon lifecycle transaction")
}

func readStopIntent() (StopIntent, bool, error) {
	data, err := os.ReadFile(StopIntentPath())
	if os.IsNotExist(err) {
		return StopIntent{}, false, nil
	}
	if err != nil {
		return StopIntent{}, false, err
	}
	var intent StopIntent
	if err := json.Unmarshal(data, &intent); err != nil {
		return StopIntent{}, false, err
	}
	if intent.Token == "" || (intent.Status != StopIntentActive && intent.Status != StopIntentComplete) {
		return StopIntent{}, false, fmt.Errorf("invalid stop intent")
	}
	return intent, true, nil
}

func ObserveStopIntent() (StopIntent, bool, error) { return readStopIntent() }
func ExplicitStopIntentActive() bool               { _, exists, err := readStopIntent(); return exists || err != nil }

func writeStopIntent(intent StopIntent) error {
	path := StopIntentPath()
	data, err := json.Marshal(intent)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".stop-intent-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	_ = tmp.Chmod(0o600)
	if _, err = tmp.Write(data); err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, path)
}

func newIntentToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err == nil {
		return hex.EncodeToString(b)
	}
	return fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano())
}

func BeginExplicitStopTransaction() (StopIntent, error) {
	lock, err := acquireLifecycleLock()
	if err != nil {
		return StopIntent{}, err
	}
	defer lock.Close()
	if current, exists, readErr := readStopIntent(); readErr == nil && exists && current.Status == StopIntentActive {
		return current, nil
	}
	intent := StopIntent{Token: newIntentToken(), Status: StopIntentActive, UpdatedAt: time.Now().UTC()}
	return intent, writeStopIntent(intent)
}

func BeginExplicitStopIntent() error { _, err := BeginExplicitStopTransaction(); return err }

func CompleteExplicitStopTransaction(token string) error {
	lock, err := acquireLifecycleLock()
	if err != nil {
		return err
	}
	defer lock.Close()
	current, exists, err := readStopIntent()
	if err != nil {
		return err
	}
	if exists && current.Token == token && current.Status == StopIntentComplete {
		return nil
	}
	if !exists || current.Token != token || current.Status != StopIntentActive {
		return fmt.Errorf("stop intent generation changed")
	}
	current.Status, current.UpdatedAt = StopIntentComplete, time.Now().UTC()
	return writeStopIntent(current)
}

func PublishDaemonPID(pid int, replacement bool, observed *StopIntent) error {
	lock, err := acquireLifecycleLock()
	if err != nil {
		return err
	}
	defer lock.Close()
	current, exists, err := readStopIntent()
	if err != nil {
		return err
	}
	if replacement {
		if exists {
			return fmt.Errorf("explicit stop intent blocks replacement publication")
		}
	} else if exists {
		if observed == nil || current.Status != StopIntentComplete || observed.Status != StopIntentComplete || current.Token != observed.Token {
			return fmt.Errorf("stop intent changed before daemon publication")
		}
		if err := os.Remove(StopIntentPath()); err != nil {
			return err
		}
	} else if observed != nil {
		return fmt.Errorf("observed stop intent changed before daemon publication")
	}
	return WritePID(pid)
}

func ClearExplicitStopIntent() error {
	lock, err := acquireLifecycleLock()
	if err != nil {
		return err
	}
	defer lock.Close()
	current, exists, readErr := readStopIntent()
	if readErr != nil {
		return readErr
	}
	if !exists {
		return nil
	}
	if current.Status != StopIntentComplete {
		return fmt.Errorf("cannot clear active stop intent")
	}
	return os.Remove(StopIntentPath())
}
