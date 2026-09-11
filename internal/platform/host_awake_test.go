package platform

import "testing"

func TestSystemCapabilitiesDistinguishDarkWake(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value uint32
		awake bool
	}{
		{"sleep", 0, false}, {"dark wake with network", 9, false},
		{"full wake", 15, true}, {"full wake without network", 3, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := fullWakeCapabilities(tc.value); got != tc.awake {
				t.Fatalf("got %v want %v", got, tc.awake)
			}
		})
	}
}

func TestIORegPowerStateParsing(t *testing.T) {
	for _, tc := range []struct {
		output string
		awake  bool
		bad    bool
	}{
		{`      "System Capabilities" = 15`, true, false},
		{`      "System Capabilities" = 9`, false, false},
		{`      "System Capabilities" = 0`, false, false},
		{`      "IOPMUserIsActive" = No`, false, true},
		{`      "System Capabilities" = 4294967296`, false, true},
	} {
		awake, err := parseHostCapabilities(tc.output)
		if awake != tc.awake || (err != nil) != tc.bad {
			t.Errorf("input=%s awake=%v err=%v", tc.output, awake, err)
		}
	}
}
