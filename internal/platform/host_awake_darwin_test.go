//go:build darwin

package platform

import "testing"

func TestHostAwakeReadsSystemCapabilities(t *testing.T) {
	awake, err := HostAwake()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("current full-wake state: %v", awake)
}
