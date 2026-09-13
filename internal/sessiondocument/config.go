package sessiondocument

import (
	"fmt"
	"strings"
)

func CaptureEnabled(value string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "off", "0", "false":
		return false, nil
	case "on", "1", "true":
		return true, nil
	default:
		return false, fmt.Errorf("POCKETCTL_SESSION_DOCUMENT_CAPTURE must be off or on")
	}
}
