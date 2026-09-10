//go:build darwin && cgo

package platform

/*
#cgo LDFLAGS: -framework IOKit -framework CoreFoundation
#include <IOKit/IOKitLib.h>
#include <CoreFoundation/CoreFoundation.h>

static int pocketctlPowerCapabilities(int32_t *value) {
    io_service_t root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"));
    if (!root) return -1;
    CFTypeRef property = IORegistryEntryCreateCFProperty(root, CFSTR("System Capabilities"), kCFAllocatorDefault, 0);
    IOObjectRelease(root);
    if (!property) return -2;
    int ok = CFGetTypeID(property) == CFNumberGetTypeID() &&
        CFNumberGetValue((CFNumberRef)property, kCFNumberSInt32Type, value);
    CFRelease(property);
    return ok ? 0 : -3;
}
*/
import "C"

import "fmt"

// HostAwake reads the current power capabilities without creating a power
// assertion, scheduling a wake, or treating DarkWake as permission to connect.
func HostAwake() (bool, error) {
	var capabilities C.int32_t
	if code := C.pocketctlPowerCapabilities(&capabilities); code != 0 {
		return false, fmt.Errorf("read IOPM system capabilities: %d", int(code))
	}
	return fullWakeCapabilities(uint32(capabilities)), nil
}
