package zcode

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type quotaBinding struct {
	Account string `json:"account"`
	Key     string `json:"api_key"`
}

// Desktop owns the v2 cipher. Bind a user-supplied key to the opaque login
// records so switching accounts or logging in again invalidates the binding.
func (r *QuotaReader) boundCredential(credentials map[string]string) (quotaCredential, error) {
	c := quotaCredential{status: "unsupported"}
	active, user := credentials["oauth:active_provider"], credentials["oauth:bigmodel:user_info"]
	if !strings.HasPrefix(user, "enc:v2:") || len(user) <= len("enc:v2:") || len(active) <= len("enc:v2:") {
		return c, errors.New("quota_credentials_unavailable")
	}
	hash := sha256.Sum256([]byte(r.root + "\x00" + active + "\x00" + user))
	c.binding = hex.EncodeToString(hash[:])
	var stored quotaBinding
	if err := quotaJSON(r.bindingPath, &stored); err != nil {
		if os.IsNotExist(err) {
			return c, nil
		}
		return c, errors.New("quota_credentials_unavailable")
	}
	if stored.Account != c.binding {
		return c, nil
	}
	if !validBindingKey(stored.Key) {
		return c, errors.New("quota_credentials_unavailable")
	}
	c.key, c.status = stored.Key, "ok"
	scope := sha256.Sum256([]byte(c.binding + "\x00" + c.key))
	c.scope = hex.EncodeToString(scope[:16])
	return c, nil
}

func validBindingKey(key string) bool {
	if key == "" || len(key) > 8192 || strings.HasPrefix(key, "enc:") {
		return false
	}
	for _, b := range []byte(key) {
		if b < 33 || b > 126 {
			return false
		}
	}
	return true
}

// BindQuotaKey verifies the explicitly supplied personal plan key using only
// the quota GET before replacing a working binding.
func (r *QuotaReader) BindQuotaKey(ctx context.Context, key string) error {
	if !validBindingKey(key) {
		return errors.New("invalid Coding Plan API key")
	}
	current, err := r.credential()
	if err != nil {
		return err
	}
	if current.binding == "" {
		return errors.New("select a protected BigModel individual Coding Plan account in ZCode Desktop first")
	}
	result, err := r.fetch(ctx, quotaCredential{key: key})
	if err != nil {
		return err
	}
	if result.Windows[0].RemainingPercent == nil && result.Windows[1].RemainingPercent == nil {
		return errors.New("no Coding Plan quota windows returned for this key")
	}
	if err := os.MkdirAll(filepath.Dir(r.bindingPath), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(r.bindingPath), ".zcode-quota-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	err = json.NewEncoder(f).Encode(quotaBinding{Account: current.binding, Key: key})
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	after, err := r.credential()
	if err != nil || after.binding != current.binding {
		return errors.New("quota_account_changed")
	}
	return os.Rename(f.Name(), r.bindingPath)
}

func (r *QuotaReader) UnbindQuotaKey() error {
	err := os.Remove(r.bindingPath)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
