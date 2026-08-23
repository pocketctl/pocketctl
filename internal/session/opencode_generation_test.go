package session

import "testing"

func TestNextOpenCodeGenerationIsMonotonic(t *testing.T) {
	if got := nextOpenCodeGeneration(0); got != 1 {
		t.Fatalf("first generation=%d", got)
	}
	if got := nextOpenCodeGeneration(41); got != 42 {
		t.Fatalf("next generation=%d", got)
	}
	if got := nextOpenCodeGeneration(^uint64(0)); got != 1 {
		t.Fatalf("overflow generation=%d", got)
	}
}
