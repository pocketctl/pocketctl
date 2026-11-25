package zcode

import (
	"context"
	"database/sql"
	"testing"
)

func TestPersonalUsageStablePartRevision(t *testing.T) {
	m := NewMapper("fixture-source")
	e, _ := m.MapPart("session", "message", "native-part", ZcodePartData{Type: "step-finish", Usage: &ZcodeUsage{InputTokens: 100, OutputTokens: 20, TotalTokens: 120}}, "actual-model", "", 2)
	if e.UsageMeta == nil || e.UsageMeta.SourceUsageID != "native-part" || e.UsageMeta.Model != "actual-model" || e.UsageMeta.Revision != 2 || e.UsageMeta.InputSemantics != "unknown" {
		t.Fatalf("%+v", e.UsageMeta)
	}
}

func TestPersonalUsageNativeErrorWithoutBody(t *testing.T) {
	m := NewMapper("fixture")
	event, _ := m.MapPart("s", "m", "p", ZcodePartData{Type: "tool", CallID: "call", State: &ZcodeToolState{Status: "error"}}, "model", "", 1)
	if event.CallMeta == nil || event.CallMeta.Outcome != "failure" {
		t.Fatalf("explicit native failure lost: %+v", event)
	}
}

func TestDesktopStepTokensThroughSync(t *testing.T) {
	syncer := NewZcodeSync("fixture-source", "session")
	preview := func(raw string) DiffBatch {
		t.Helper()
		part, ok := DecodePartData(raw)
		if !ok {
			t.Fatalf("decode: %s", raw)
		}
		batch, err := syncer.PreviewPart("native-part", "native-message", "message", part, "plan/model", MessageScope{Role: "assistant"})
		if err != nil {
			t.Fatal(err)
		}
		return batch
	}
	// The assistant message can also carry a summary. Only the step part is a
	// usage source. Cache reads are already included in Desktop's input.
	first := `{"type":"step-finish","reason":"tool-calls","tokens":{"total":34909,"input":33753,"output":1156,"reasoning":0,"cache":{"read":30464,"write":0}}}`
	updated := `{"type":"step-finish","tokens":{"total":34909,"input":33753,"output":1156,"reasoning":0,"cache":{"read":30000,"write":464}}}`
	ids := make(map[string]bool)
	var prev string
	for i, raw := range []string{first, updated, first} {
		batch := preview(raw)
		if len(batch.Events) != 1 {
			t.Fatalf("revision %d: %+v", i+1, batch)
		}
		ev := batch.Events[0]
		u := ev.Usage
		if u == nil || u.InputTokens != 3289 || u.OutputTokens != 1156 || u.CacheRead+u.CacheCreate != 30464 || u.TotalTokens != 34909 {
			t.Fatalf("wrong counters: %+v", u)
		}
		if (i == 1 && u.CacheCreate != 464) || (i != 1 && u.CacheCreate != 0) {
			t.Fatalf("wrong cache split: %+v", u)
		}
		meta := ev.UsageMeta
		if meta == nil || meta.InputSemantics != "excludes_cache" || meta.SourceUsageID != "native-part" || meta.Model != "plan/model" || meta.Revision != int64(i+1) {
			t.Fatalf("wrong metadata: %+v", meta)
		}
		if ev.EventID == "" || ids[ev.EventID] || ev.PreviousEventID != prev {
			t.Fatalf("unexpected event identity at revision %d: %+v", i+1, ev)
		}
		prev = ev.EventID
		ids[prev] = true
		if err := syncer.applyProvisional(batch.Commit); err != nil {
			t.Fatal(err)
		}
		if duplicate := preview(raw); duplicate.SkipReason != "skip" || len(duplicate.Events) != 0 {
			t.Fatalf("unchanged poll: %+v", duplicate)
		}
	}
}

func TestObserverDesktopUsageSourceTimeAndIdentity(t *testing.T) {
	ctx := context.Background()
	const created = int64(1700000000123)
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "session", "desktop", "/repo", created, created, 0)
		insertMessage(ctx, db, "msg", "session", 1, created, created, `{"role":"assistant","modelId":"model","tokens":{"input":33753,"output":1156}}`)
		insertPart(ctx, db, "step", "msg", "session", 1, created, created+1000, `{"type":"step-finish","tokens":{"input":33753,"output":1156,"total":34909,"cache":{"read":30464,"write":0}}}`)
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(ctx)
	ackAllEmitted(t, cs, rec)
	o.pollOnce(ctx)
	count := 0
	for _, ev := range rec.snapshot() {
		if ev.Usage == nil {
			continue
		}
		count++
		if ev.Usage.TotalTokens != 34909 || ev.UsageMeta == nil || ev.UsageMeta.SourceUsageID != "step" ||
			ev.UsageMeta.OccurredAt != "2023-11-14T22:13:20.123Z" || ev.UsageMeta.Model != "model" {
			t.Fatalf("unexpected observed usage: %+v %+v", ev.Usage, ev.UsageMeta)
		}
	}
	if count != 1 {
		t.Fatalf("wanted one observed usage event, got %d", count)
	}
}

func TestStepUsageAliasesAndInvalidDesktopCounters(t *testing.T) {
	m := NewMapper("fixture-source")
	legacy := `"usage":{"input":11,"output":3,"reasoning":2,"total":14}`
	desktop := `"tokens":{"input":100,"output":20,"total":120,"cache":{"read":30,"write":0}}`
	for _, fields := range []string{legacy, desktop + "," + legacy} {
		part, ok := DecodePartData(`{"type":"step-finish",` + fields + `}`)
		if !ok {
			t.Fatal("decode legacy usage")
		}
		ev, reason := m.MapPart("session", "message", "p", part, "", "", 1)
		if reason != "" || ev.EventID != m.partEventID("p", "usage", "11-3-2-14") ||
			ev.Usage == nil || ev.Usage.InputTokens != 11 || ev.UsageMeta.InputSemantics != "unknown" {
			t.Fatalf("legacy identity or counters changed: %+v", ev)
		}
	}
	for _, counters := range []string{
		`{}`,
		`{"input":100,"output":20,"cache":{"read":30}}`,
		`{"input":100,"output":20,"total":130,"cache":{"read":30}}`,
		`{"input":100,"output":20,"total":120,"cache":{"read":90,"write":20}}`,
	} {
		part, ok := DecodePartData(`{"type":"step-finish","tokens":` + counters + `}`)
		if !ok {
			t.Fatal("decode partial usage")
		}
		ev, reason := m.MapPart("session", "message", "p", part, "", "", 1)
		if ev.Usage != nil || reason != "skip" {
			t.Fatalf("unsupported counters generated usage: %s", counters)
		}
	}
}
