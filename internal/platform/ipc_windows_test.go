//go:build windows

package platform

import (
	"strings"
	"testing"

	"github.com/Microsoft/go-winio"
)

func TestWindowsPipeSecurityDescriptorIsCurrentUserOnly(t *testing.T) {
	sddl := windowsPipeSecurityDescriptor("S-1-5-21-1000")
	if !strings.Contains(sddl, ";;;SY)") || !strings.Contains(sddl, ";;;S-1-5-21-1000)") {
		t.Fatalf("pipe ACL is missing SYSTEM or current user: %q", sddl)
	}
	for _, broadPrincipal := range []string{";;;WD)", ";;;AU)", ";;;BU)"} {
		if strings.Contains(sddl, broadPrincipal) {
			t.Fatalf("pipe ACL grants a broad principal %q: %q", broadPrincipal, sddl)
		}
	}
	if _, err := winio.SddlToSecurityDescriptor(sddl); err != nil {
		t.Fatalf("pipe ACL is invalid SDDL: %v", err)
	}
}
