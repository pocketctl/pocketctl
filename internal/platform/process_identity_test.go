package platform

import (
	"errors"
	"math"
	"os"
	"strconv"
	"strings"
	"testing"
)

func TestValidateProcessStartIdentityPIDRejectsValuesOutsideKernelPIDRange(t *testing.T) {
	pids := []int{0, -1}
	if strconv.IntSize == 64 {
		tooLarge := uint64(math.MaxUint32) + 1
		pids = append(pids, int(tooLarge))
	}
	for _, pid := range pids {
		if err := validateProcessStartIdentityPID(pid); err == nil {
			t.Fatalf("pid %d was accepted", pid)
		}
	}
}

func TestParseLinuxProcStatStartTimeHandlesSpacesAndParenthesesInComm(t *testing.T) {
	stat := strings.Join([]string{
		"123",
		"(worker (alpha) beta)",
		"S",
		"1",
		"2",
		"3",
		"4",
		"5",
		"6",
		"7",
		"8",
		"9",
		"10",
		"11",
		"12",
		"13",
		"14",
		"15",
		"16",
		"17",
		"18",
		"987654321",
		"23",
	}, " ")

	got, err := parseLinuxProcStatStartTime([]byte(stat))
	if err != nil {
		t.Fatal(err)
	}
	if got != "987654321" {
		t.Fatalf("starttime=%q want 987654321", got)
	}
}

func TestParseLinuxProcStatStartTimeRejectsMalformedInput(t *testing.T) {
	for _, stat := range []string{
		"123 worker S 1 2 3",
		"123 (worker) S 1 2 3",
		"123 (worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 nope",
	} {
		if got, err := parseLinuxProcStatStartTime([]byte(stat)); err == nil {
			t.Fatalf("stat=%q returned %q", stat, got)
		}
	}
}

func TestFormatWindowsProcessCreationTimePreservesAllFiletimeBits(t *testing.T) {
	got := formatWindowsProcessCreationTime(0x01234567, 0x89abcdef)
	if got != "windows:81985529216486895" {
		t.Fatalf("identity=%q", got)
	}
}

func TestProcessStartIdentityWindowsUsesCreationTimeForRunningProcess(t *testing.T) {
	got, err := processStartIdentityWindows(
		123,
		func(pid int) (windowsProcessStartInfo, error) {
			if pid != 123 {
				t.Fatalf("queried pid=%d", pid)
			}
			return windowsProcessStartInfo{
				CreationTimeHigh: 0x01234567,
				CreationTimeLow:  0x89abcdef,
				Running:          true,
			}, nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got != "windows:81985529216486895" {
		t.Fatalf("identity=%q", got)
	}
}

func TestProcessStartIdentityWindowsTreatsAccessDeniedAndExitAsErrors(t *testing.T) {
	if _, err := processStartIdentityWindows(
		123,
		func(int) (windowsProcessStartInfo, error) {
			return windowsProcessStartInfo{}, os.ErrPermission
		},
	); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("access denied error=%v", err)
	}
	if _, err := processStartIdentityWindows(
		123,
		func(int) (windowsProcessStartInfo, error) {
			return windowsProcessStartInfo{
				CreationTimeHigh: 1,
				Running:          false,
			}, nil
		},
	); err == nil {
		t.Fatal("exited process was accepted")
	}
}
