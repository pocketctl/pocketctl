//go:build darwin

package platform

import (
	"reflect"
	"testing"
)

func TestCaffeinateCommandPreventsIdleAndSystemSleep(t *testing.T) {
	cmd := newCaffeinateCommand(1234)
	want := []string{"caffeinate", "-i", "-s", "-w", "1234"}
	if !reflect.DeepEqual(cmd.Args, want) {
		t.Fatalf("caffeinate args = %q, want %q", cmd.Args, want)
	}
}
