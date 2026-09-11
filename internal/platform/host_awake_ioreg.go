package platform

import (
	"fmt"
	"regexp"
	"strconv"
)

var systemCapabilitiesPattern = regexp.MustCompile(`(?m)^\s*"System Capabilities" = ([0-9]+)\s*$`)

func parseHostCapabilities(output string) (bool, error) {
	match := systemCapabilitiesPattern.FindStringSubmatch(output)
	if match == nil {
		return false, fmt.Errorf("IOPM system capabilities missing")
	}
	value, err := strconv.ParseUint(match[1], 10, 32)
	if err != nil {
		return false, err
	}
	return fullWakeCapabilities(uint32(value)), nil
}
