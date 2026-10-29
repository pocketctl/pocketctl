package session

import (
	"encoding/json"
	"os"
	"path/filepath"
)

func agentTeamsMarker(root, scope, installation string) (string, []byte, error) {
	if !filepath.IsAbs(root) || !externalIdentifier(scope) || !externalIdentifier(installation) {
		return "", nil, ErrExternalIdentity
	}
	data, _ := json.Marshal(struct{ Scope, Installation string }{scope, installation})
	return filepath.Join(root, externalPayloadDigest([]byte(scope)), "agentteams-installation.json"), data, nil
}

// InitializeAgentTeamsJournal is an explicit offline installation operation.
// A durable marker is reserved before creating the DB and is never recreated
// automatically. Interrupted initialization requires operator reconciliation.
func InitializeAgentTeamsJournal(root, scope, installation string) (*ExternalJournal, error) {
	marker, data, err := agentTeamsMarker(root, scope, installation)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Dir(marker), 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(filepath.Dir(marker))
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return nil, ErrExternalIdentity
	}
	f, err := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, err
	}
	_, err = f.WriteString("initializing\n")
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, err
	}
	dbPath := filepath.Join(filepath.Dir(marker), "external-executions.db")
	if _, err = os.Lstat(dbPath); !os.IsNotExist(err) {
		return nil, ErrExternalConflict
	}
	j, err := OpenExternalJournal(root, scope)
	if err != nil {
		return nil, err
	}
	ready, err := os.OpenFile(marker+".ready", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err == nil {
		_, err = ready.Write(data)
		if err == nil {
			err = ready.Sync()
		}
		closeErr = ready.Close()
		if err == nil {
			err = closeErr
		}
	}
	if err == nil {
		err = os.Rename(marker+".ready", marker)
	}
	if err == nil {
		var dir *os.File
		dir, err = os.Open(filepath.Dir(marker))
		if err == nil {
			err = dir.Sync()
			dir.Close()
		}
	}
	if err != nil {
		j.Close()
		return nil, err
	}
	return j, nil
}

// OpenAgentTeamsJournal never creates a missing database or installation marker.
// Consequently loss of bridge storage cannot become an absence/retry receipt.
func OpenAgentTeamsJournal(root, scope, installation string) (*ExternalJournal, error) {
	marker, want, err := agentTeamsMarker(root, scope, installation)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(marker)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 8192 {
		return nil, ErrExternalCorrupt
	}
	got, err := os.ReadFile(marker)
	if err != nil || string(got) != string(want) {
		return nil, ErrExternalCorrupt
	}
	return openExternalJournal(root, scope, false)
}
