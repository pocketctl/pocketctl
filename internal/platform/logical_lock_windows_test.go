//go:build windows

package platform

import (
	"errors"
	"testing"
)

func TestWindowsLogicalLockerIgnoresPathAliases(t *testing.T) {
	original := currentWindowsUserSID
	currentWindowsUserSID = func() (string, error) { return "S-1-5-21-100", nil }
	defer func() { currentWindowsUserSID = original }()

	locker := windowsLogicalLocker{logicalID: "daemon-lifecycle"}
	first, err := locker.mutexName(`C:\Users\Alice\.pocketctl\daemon-stop.intent.lock`)
	if err != nil {
		t.Fatal(err)
	}
	for _, alias := range []string{
		`c:\users\ALICE\.pocketctl\DAEMON-STOP.INTENT.LOCK`,
		`C:\Users\ALICE~1\.pocketctl\daemon-stop.intent.lock`,
	} {
		got, err := locker.mutexName(alias)
		if err != nil {
			t.Fatal(err)
		}
		if got != first {
			t.Fatalf("path alias changed logical mutex identity: %q != %q", got, first)
		}
	}
}

func TestWindowsLogicalLockerFailsClosedWhenSIDLookupFails(t *testing.T) {
	original := currentWindowsUserSID
	currentWindowsUserSID = func() (string, error) { return "", errors.New("token unavailable") }
	defer func() { currentWindowsUserSID = original }()

	locker := windowsLogicalLocker{logicalID: "daemon-lifecycle"}
	if _, err := locker.mutexName(`C:\anything`); err == nil {
		t.Fatal("SID lookup failure fell back to path-derived mutex identity")
	}
}
