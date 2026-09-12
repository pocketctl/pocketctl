package sessiondocument

import "testing"

func TestCaptureEnabledDefaultsOffAndRejectsAmbiguousValues(t *testing.T) {
	for _, value := range []string{"", "off", "0", "false"} {
		enabled, err := CaptureEnabled(value)
		if err != nil || enabled {
			t.Fatalf("%q = %v, %v", value, enabled, err)
		}
	}
	for _, value := range []string{"on", "1", "true"} {
		enabled, err := CaptureEnabled(value)
		if err != nil || !enabled {
			t.Fatalf("%q = %v, %v", value, enabled, err)
		}
	}
	if enabled, err := CaptureEnabled("shadow"); err == nil || enabled {
		t.Fatalf("ambiguous value accepted: %v, %v", enabled, err)
	}
}
