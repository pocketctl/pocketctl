//go:build !windows

package agentcontrol

import "os"

func cleanupAgentControlEndpoint(path string) { _ = os.Remove(path) }
