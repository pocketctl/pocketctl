package approval

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

func sendToolHook(t *testing.T, sock, session, call, command string) net.Conn {
	t.Helper()
	c := dialIPC(t, sock)
	t.Cleanup(func() { c.Close() })
	b, _ := json.Marshal(map[string]any{"session_id": session, "tool_use_id": call, "tool": "Bash", "input": map[string]string{"command": command}, "perm_mode": "default"})
	if _, err := c.Write(append(b, '\n')); err != nil {
		t.Fatal(err)
	}
	return c
}

func readToolDecision(t *testing.T, c net.Conn) hookResponse {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(time.Second))
	var r hookResponse
	if err := json.NewDecoder(bufio.NewReader(c)).Decode(&r); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestDuplicateToolHooksShareDecision(t *testing.T) {
	for _, allow := range []bool{false, true} {
		t.Run(map[bool]string{false: "deny", true: "allow"}[allow], func(t *testing.T) {
			s := NewServer(testIPCPath(t), nil)
			requests := make(chan Request, 8)
			s.SetOnRequest(func(r Request) { requests <- r })
			if err := s.Start(); err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			a := sendToolHook(t, s.SocketPath(), "s1", "call1", "printf same")
			r := <-requests
			b := sendToolHook(t, s.SocketPath(), "s1", "call1", "printf same")
			select {
			case extra := <-requests:
				t.Fatalf("same tool invocation published a second approval: %s", extra.RequestID)
			case <-time.After(50 * time.Millisecond):
			}
			if err := s.Resolve(r.RequestID, allow); err != nil {
				t.Fatal(err)
			}
			for _, c := range []net.Conn{a, b} {
				if got := readToolDecision(t, c); got.Allow != allow {
					t.Fatalf("decision=%+v want allow=%v", got, allow)
				}
			}
			// A hook started after the first result must not ask a second time.
			late := sendToolHook(t, s.SocketPath(), "s1", "call1", "printf same")
			if got := readToolDecision(t, late); got.Allow != allow {
				t.Fatalf("late decision=%+v", got)
			}
			select {
			case <-requests:
				t.Fatal("late duplicate asked again")
			default:
			}
			// Identical text in another invocation still needs its own approval.
			other := sendToolHook(t, s.SocketPath(), "s1", "call2", "printf same")
			next := <-requests
			if next.RequestID == r.RequestID {
				t.Fatal("different tool invocations merged")
			}
			s.Resolve(next.RequestID, false)
			readToolDecision(t, other)
		})
	}
}

func TestManagedHookFailsClosedWhenBrokerUnavailable(t *testing.T) {
	t.Setenv("POCKETCTL_SESSION_ID", "managed-session")
	t.Setenv("POCKETCTL_APPROVAL_SOCK", testIPCPath(t))
	t.Setenv("POCKETCTL_PERM_MODE", "default")
	in, err := os.CreateTemp(t.TempDir(), "input")
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	in.WriteString(`{"session_id":"managed-session","tool_name":"Bash","tool_use_id":"call1","tool_input":{"command":"printf safe"}}`)
	in.Seek(0, 0)
	out, err := os.CreateTemp(t.TempDir(), "output")
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	oldIn, oldOut := os.Stdin, os.Stdout
	os.Stdin, os.Stdout = in, out
	defer func() { os.Stdin, os.Stdout = oldIn, oldOut }()
	RunHook(nil)
	out.Seek(0, 0)
	var result map[string]any
	if err := json.NewDecoder(out).Decode(&result); err != nil {
		t.Fatal(err)
	}
	decision, _ := result["hookSpecificOutput"].(map[string]any)
	if decision["permissionDecision"] != "deny" {
		t.Fatalf("managed approval failure must deny, got %v", result)
	}
}

func TestApprovalReturnsBeforeClaudeDefaultHookDeadline(t *testing.T) {
	// Claude command hooks are cancelled after 600s; their output is discarded.
	// Both broker and socket fallback need time to print a denial before then,
	// including for existing user hooks that have no explicit timeout setting.
	if approvalTimeout+30*time.Second >= 600*time.Second {
		t.Fatal("approval and socket deadlines can lose the race to Claude's 600s hook deadline")
	}
}

func TestDuplicateToolIDWithChangedInputIsDenied(t *testing.T) {
	s := NewServer(testIPCPath(t), nil)
	requests := make(chan Request, 2)
	s.SetOnRequest(func(r Request) { requests <- r })
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a := sendToolHook(t, s.SocketPath(), "s1", "call1", "printf safe")
	r := <-requests
	s.Resolve(r.RequestID, true)
	readToolDecision(t, a)
	b := sendToolHook(t, s.SocketPath(), "s1", "call1", "printf different")
	got := readToolDecision(t, b)
	if got.Allow || !strings.Contains(got.Reason, "conflict") {
		t.Fatalf("changed input reused decision: %+v", got)
	}
}

func TestDuplicateHooksShareTerminalOutcomes(t *testing.T) {
	for _, outcome := range []string{"timeout", "drain", "shutdown", "disconnect"} {
		t.Run(outcome, func(t *testing.T) {
			s := NewServer(testIPCPath(t), nil)
			if outcome == "timeout" {
				s.timeout = 100 * time.Millisecond
			}
			requests := make(chan Request, 8)
			finished := make(chan Finished, 8)
			s.SetOnRequest(func(r Request) { requests <- r })
			s.SetOnFinished(func(f Finished) { finished <- f })
			if err := s.Start(); err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			a := sendToolHook(t, s.SocketPath(), "s1", "call1", "printf safe")
			<-requests
			b := sendToolHook(t, s.SocketPath(), "s1", "call1", "printf safe")
			select {
			case <-requests:
				t.Fatal("duplicate request")
			case <-time.After(20 * time.Millisecond):
			}
			switch outcome {
			case "drain":
				s.DrainSession("s1")
			case "shutdown":
				s.Close()
			case "disconnect":
				a.Close()
			}
			if got := readToolDecision(t, b); got.Allow {
				t.Fatalf("%s allowed duplicate", outcome)
			}
			if outcome != "disconnect" {
				if got := readToolDecision(t, a); got.Allow {
					t.Fatal("leader allowed")
				}
			}
			select {
			case <-finished:
			case <-time.After(time.Second):
				t.Fatal("missing finish")
			}
			select {
			case f := <-finished:
				t.Fatalf("extra finish: %+v", f)
			default:
			}
		})
	}
}

func TestToolInvocationIdentityDoesNotMergeSessionsOrLegacyRequests(t *testing.T) {
	s := NewServer(testIPCPath(t), nil)
	requests := make(chan Request, 8)
	s.SetOnRequest(func(r Request) { requests <- r })
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, key := range [][2]string{{"s1", "call1"}, {"s2", "call1"}, {"s1", ""}, {"s1", ""}} {
		c := sendToolHook(t, s.SocketPath(), key[0], key[1], "printf same")
		select {
		case r := <-requests:
			s.Resolve(r.RequestID, false)
		case <-time.After(time.Second):
			t.Fatal("independent call was merged")
		}
		if readToolDecision(t, c).Allow {
			t.Fatal("allowed")
		}
	}
}

func TestToolInvocationFingerprintPreservesLargeNumbers(t *testing.T) {
	s := NewServer(testIPCPath(t), nil)
	_, _, conflict := s.joinToolCall(hookRequest{SessionID: "s", ToolUseID: "call", Tool: "custom", Input: json.RawMessage(`{"id":9007199254740992}`)})
	if conflict {
		t.Fatal("first request rejected")
	}
	_, _, conflict = s.joinToolCall(hookRequest{SessionID: "s", ToolUseID: "call", Tool: "custom", Input: json.RawMessage(`{"id":9007199254740993}`)})
	if !conflict {
		t.Fatal("different integer inputs collapsed into one approval fingerprint")
	}
}
