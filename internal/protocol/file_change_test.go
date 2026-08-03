package protocol

import "testing"

func TestAgentFileChangeKindsAreClosed(t *testing.T) {
	for _, kind := range []string{"create", "update", "delete", "move"} {
		if !ValidFileChangeKind(kind) {
			t.Fatalf("known file change kind rejected: %q", kind)
		}
	}

	for _, kind := range []string{"", "add", "modify", "rename", "UPDATE"} {
		if ValidFileChangeKind(kind) {
			t.Fatalf("unknown file change kind accepted: %q", kind)
		}
	}
}

func TestCountUnifiedDiffChangesIgnoresHeadersAndCountsBodyLines(t *testing.T) {
	diff := "--- a/a.txt\n" +
		"+++ b/a.txt\n" +
		"@@ -1,3 +1,4 @@\n" +
		" context\n" +
		"-old\n" +
		"+new\n" +
		"+\n" +
		"@@ -10,2 +11 @@\n" +
		"-removed\n" +
		"-\n" +
		" same\n" +
		"\\ No newline at end of file\n"

	additions, deletions := CountUnifiedDiffChanges(diff)
	if additions != 2 || deletions != 3 {
		t.Fatalf("CountUnifiedDiffChanges() = (+%d, -%d), want (+2, -3)", additions, deletions)
	}
}

func TestCountUnifiedDiffChangesDoesNotMistakeAddedContentForAHeader(t *testing.T) {
	diff := "@@ -0,0 +1 @@\n+++body\n"
	additions, deletions := CountUnifiedDiffChanges(diff)
	if additions != 1 || deletions != 0 {
		t.Fatalf("CountUnifiedDiffChanges() = (+%d, -%d), want (+1, -0)", additions, deletions)
	}
}

func TestCountUnifiedDiffChangesEmptyInput(t *testing.T) {
	additions, deletions := CountUnifiedDiffChanges("")
	if additions != 0 || deletions != 0 {
		t.Fatalf("CountUnifiedDiffChanges(\"\") = (+%d, -%d), want (+0, -0)", additions, deletions)
	}
}
