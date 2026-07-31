//go:build !darwin && !linux && !windows

package platform

import "fmt"

func ProcessStartIdentity(pid int) (string, error) {
	if err := validateProcessStartIdentityPID(pid); err != nil {
		return "", err
	}
	return "", fmt.Errorf("process start identity: %w", ErrUnsupported)
}
