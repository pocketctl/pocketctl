//go:build windows

package daemon

import "os"

// The state lives below the current user's profile and is opened with private
// mode. Windows ownership enforcement is provided by the profile ACL.
func stateFileOwnedByCurrentUser(info os.FileInfo) bool { return true }
