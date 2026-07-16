package platform

import (
	"crypto/sha256"
	"fmt"
)

func logicalLockKernelName(logicalID, userID string) (string, error) {
	if logicalID == "" {
		return "", fmt.Errorf("logical lock ID is required")
	}
	if userID == "" {
		return "", fmt.Errorf("logical lock user identity is required")
	}
	sum := sha256.Sum256([]byte(userID + "\x00" + logicalID))
	return fmt.Sprintf(`Global\pocketctl-logical-lock-%x`, sum[:16]), nil
}
