package platform

// IOPM system capabilities describe full wake independently of display idle,
// screen lock, or user idle. CPU+network alone is a maintenance/DarkWake.
// Values are defined in Apple's IOKit/pwr_mgt/IOPM.h.
func fullWakeCapabilities(capabilities uint32) bool {
	const cpuAndGraphics = 0x01 | 0x02
	return capabilities&cpuAndGraphics == cpuAndGraphics
}
