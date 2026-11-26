package session

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexManagedUsageUsesMatchingRolloutTurn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	write := func(s string) {
		t.Helper()
		if _, err := f.WriteString(s); err != nil {
			t.Fatal(err)
		}
	}
	write("{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread\"}}\n")
	write("{\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"one\",\"model\":\"first\"}}\n")
	p := newCodexProjection(2)
	register := func(thread string) {
		p.ProjectResumedThread([]byte(fmt.Sprintf(`{"id":%q,"path":%q}`, thread, path)), thread, 0, "")
	}
	p.Project(codexNotification("thread/started", fmt.Sprintf(`{"thread":{"id":"thread","path":%q}}`, path)))
	seq := 0
	usage := func(thread, turn, want string) {
		t.Helper()
		seq++
		msg := codexNotification("thread/tokenUsage/updated", fmt.Sprintf(`{"threadId":%q,"turnId":%q,"tokenUsage":{"last":{"totalTokens":%d}}}`, thread, turn, seq))
		ev := p.Project(msg)
		if len(ev) != 1 || ev[0].UsageMeta.Model != want || ev[0].Model != "" || ev[0].Usage.TotalTokens != seq {
			t.Fatalf("usage %s/%s: %+v, want attribution %q", thread, turn, ev, want)
		}
		if len(p.Project(msg)) != 0 {
			t.Fatal("duplicate usage")
		}
	}
	usage("thread", "one", "first")
	write(fmt.Sprintf("{\"type\":\"response_item\",\"payload\":{\"text\":%q}}\n", strings.Repeat("x", 2<<20)))
	write(`{"type":"turn_context","payload":{"turn_id":"two","model":"second"}}`)
	usage("thread", "two", "")
	write("\n")
	usage("thread", "two", "second")
	usage("thread", "one", "first")
	usage("thread", "missing", "")
	write("{\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"two\",\"model\":\"changed\"}}\n")
	usage("thread", "two", "")
	usage("thread", "one", "first")
	register("other")
	usage("other", "one", "")
	restored := newCodexProjection(3)
	p = restored
	register("thread")
	usage("thread", "one", "first")
	usage("thread", "two", "")
}
