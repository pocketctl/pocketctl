package zcode

import (
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Review P1-2: the turn state advances only through the SyncCommit — a
// rejected page's preview must not pollute the canonical projection, and the
// checkpoint round-trip keeps a long turn's anchor across restarts.
func TestZcodeTurnStateAdvancesViaCommitOnly(t *testing.T) {
	canonical := NewZcodeSync(testSourceID, "zcode-wire1")

	// Scratch preview of a user message that starts a turn.
	scratch := canonical.Clone()
	batch, err := scratch.PreviewMessage("m1", "wm1", ZcodeMessageData{
		Role: "user", Parts: []ZcodePartData{{Type: "text", Text: "hello"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Events) != 2 || batch.Events[0].TurnStatus != protocol.TurnStateRunning {
		t.Fatalf("preview batch = %+v", batch.Events)
	}
	if batch.Commit.Turn == nil || batch.Commit.Turn.Anchor != "m1" || batch.Commit.Turn.State != protocol.TurnStateRunning {
		t.Fatalf("turn commit = %+v", batch.Commit.Turn)
	}
	// The canonical projection is untouched by the scratch preview.
	if canonical.state.turnAnchor != "" || len(canonical.state.turnEmitted) != 0 {
		t.Fatal("scratch preview leaked into the canonical projection")
	}
	// Acknowledged: the commit advances the canonical turn state.
	if err := canonical.ApplyAccepted(setOrder(batch.Commit, 1)); err != nil {
		t.Fatal(err)
	}
	if canonical.state.turnAnchor != "m1" {
		t.Fatalf("canonical anchor = %q", canonical.state.turnAnchor)
	}

	// Terminal fact: assistant finish closes the turn through a commit.
	batch2, err := canonical.Clone().PreviewMessage("m2", "wm2", ZcodeMessageData{
		Role: "assistant", Finish: "stop",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(batch2.Events) != 1 || batch2.Events[0].TurnStatus != protocol.TurnStateCompleted {
		t.Fatalf("terminal batch = %+v", batch2.Events)
	}
	if canonical.state.turnAnchor != "m1" {
		t.Fatal("terminal preview must not close the canonical turn before the commit")
	}
	if err := canonical.ApplyAccepted(setOrder(batch2.Commit, 2)); err != nil {
		t.Fatal(err)
	}
	if canonical.state.turnAnchor != "" {
		t.Fatal("canonical turn must close after the commit")
	}
	if canonical.state.turnEmitted["m1"] != protocol.TurnStateCompleted {
		t.Fatalf("emitted ledger = %+v", canonical.state.turnEmitted)
	}
}

// Review P1-2: the durable checkpoint round-trips the turn state so a long
// turn keeps its anchor across restarts.
func TestZcodeCheckpointRoundTripsTurnState(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire2")
	if err := z.ApplyAccepted(setOrder(SyncCommit{Turn: &TurnCommit{Anchor: "m9", State: protocol.TurnStateRunning}}, 1)); err != nil {
		t.Fatal(err)
	}
	cp := z.Checkpoint()
	if cp.TurnAnchor != "m9" || cp.TurnEmitted["m9"] != protocol.TurnStateRunning {
		t.Fatalf("checkpoint turn = %q %+v", cp.TurnAnchor, cp.TurnEmitted)
	}
	restored, err := NewZcodeSyncFromCheckpoint(testSourceID, "zcode-wire2", cp)
	if err != nil {
		t.Fatal(err)
	}
	if restored.state.turnAnchor != "m9" || restored.state.turnEmitted["m9"] != protocol.TurnStateRunning {
		t.Fatalf("restored turn = %q %+v", restored.state.turnAnchor, restored.state.turnEmitted)
	}
	// The restored projection keeps idempotency: re-previewing the same user
	// message emits nothing new.
	batch, err := restored.Clone().PreviewMessage("m9", "wm9", ZcodeMessageData{
		Role: "user", Parts: []ZcodePartData{{Type: "text", Text: "hello"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range batch.Events {
		if ev.Type == protocol.EventTypeTurnStatus {
			t.Fatal("restored running turn must not re-emit")
		}
	}
}

// Terminal turns never reopen through a stale commit.
func TestZcodeTerminalTurnNeverReopensViaCommit(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire3")
	if err := z.ApplyAccepted(setOrder(SyncCommit{Turn: &TurnCommit{Anchor: "m1", State: protocol.TurnStateRunning}}, 1)); err != nil {
		t.Fatal(err)
	}
	if err := z.ApplyAccepted(setOrder(SyncCommit{Turn: &TurnCommit{Anchor: "m1", State: protocol.TurnStateCompleted}}, 2)); err != nil {
		t.Fatal(err)
	}
	// A late commit claiming the same anchor is running again is ignored.
	if err := z.ApplyAccepted(setOrder(SyncCommit{Turn: &TurnCommit{Anchor: "m1", State: protocol.TurnStateRunning}}, 3)); err != nil {
		t.Fatal(err)
	}
	if z.state.turnEmitted["m1"] != protocol.TurnStateCompleted {
		t.Fatalf("terminal turn rewritten: %+v", z.state.turnEmitted)
	}
}

func setOrder(c SyncCommit, order uint64) SyncCommit {
	c.CommitOrder = order
	return c
}
