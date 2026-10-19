//go:build windows

package update

import "os"

func preserveInstallOwner(_ string, _ os.FileInfo) error { return nil }
func IsElevated() bool                                   { return false }
func NeedsElevation(_ string) (bool, error)              { return false, nil }
func ValidateElevatedExecutable(_ string) error          { return nil }
