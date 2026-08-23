package platform

import "testing"

func TestLogicalLockKernelNameIsStableAndUserScoped(t *testing.T) {
	first, err := logicalLockKernelName("daemon-lifecycle", "S-1-5-21-100")
	if err != nil {
		t.Fatal(err)
	}
	second, err := logicalLockKernelName("daemon-lifecycle", "S-1-5-21-100")
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("same logical lock and user produced different names: %q != %q", first, second)
	}
	otherUser, err := logicalLockKernelName("daemon-lifecycle", "S-1-5-21-200")
	if err != nil {
		t.Fatal(err)
	}
	if first == otherUser {
		t.Fatal("different users shared a logical kernel lock name")
	}
	otherLock, err := logicalLockKernelName("another-lock", "S-1-5-21-100")
	if err != nil {
		t.Fatal(err)
	}
	if first == otherLock {
		t.Fatal("different logical locks shared a kernel lock name")
	}
}

func TestLogicalLockKernelNameRejectsMissingIdentity(t *testing.T) {
	for _, tc := range []struct{ logicalID, userID string }{{"", "S-1"}, {"daemon-lifecycle", ""}} {
		if _, err := logicalLockKernelName(tc.logicalID, tc.userID); err == nil {
			t.Fatalf("accepted logicalID=%q userID=%q", tc.logicalID, tc.userID)
		}
	}
}
