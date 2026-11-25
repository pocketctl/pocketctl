package zcode

import (
	"context"
	"database/sql"
	"testing"
)

func TestObserverSessionModelDiscoveryAndParts(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "session", "desktop", "/repo", 1, 1, 0)
		insertMessage(ctx, db, "first", "session", 1, 1, 1, `{"role":"assistant","model":{"providerID":"plan","modelID":"old"}}`)
		insertPart(ctx, db, "old-text", "first", "session", 1, 1, 1, textPartJSON("old answer"))
		insertMessage(ctx, db, "second", "session", 2, 2, 2, `{"role":"assistant","providerId":"plan","modelId":"GLM-5.4"}`)
		insertPart(ctx, db, "new-text", "second", "session", 1, 2, 2, textPartJSON("new answer"))
		insertMessage(ctx, db, "hidden", "session", 3, 3, 3, `{"role":"assistant","hidden":true,"modelID":"hidden"}`)
		insertMessage(ctx, db, "empty", "session", 4, 4, 4, `{"role":"assistant"}`)
		insertMessage(ctx, db, "user", "session", 5, 5, 5, `{"role":"user","model":{"modelID":"requested"}}`)
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.resyncActive = true
	o.pollOnce(context.Background())
	want := map[string]string{"discovery": "plan/GLM-5.4", "reconnect": "plan/GLM-5.4", "old answer": "plan/old", "new answer": "plan/GLM-5.4"}
	for _, ev := range rec.snapshot() {
		var key string
		switch ev.Type {
		case "session_discovered":
			key = "discovery"
			if ev.Resync {
				key = "reconnect"
			}
		case "agent_text":
			key = ev.Text
		default:
			continue
		}
		if ev.Model != want[key] {
			t.Errorf("%s model = %q, want %q", key, ev.Model, want[key])
		}
		delete(want, key)
	}
	if len(want) != 0 {
		t.Fatalf("missing events: %v", want)
	}
}

func TestObserverSessionModelBackfillAndSwitch(t *testing.T) {
	ctx := context.Background()
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "session", "desktop", "/repo", 1, 1, 0)
		insertMessage(ctx, db, "reply", "session", 1, 1, 1, `{"role":"assistant"}`)
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(ctx)
	ackAllEmitted(t, cs, rec)
	o.cfg.History = HistoryRecent // The known session is outside the lookback.
	db, err := sql.Open("sqlite", "file:"+storage+"/db/db.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	seen := map[string]bool{}
	for _, model := range []string{"A", "B", "A"} {
		// Keep all row timestamps and sequence cursors fixed, as after upgrading
		// an idle session originally acknowledged with an empty model.
		_, err = db.Exec("UPDATE message SET data=json_set(data,'$.modelId',?) WHERE id='reply'", model)
		if err != nil {
			t.Fatal(err)
		}
		before := len(rec.snapshot())
		o.pollOnce(ctx)
		events := rec.snapshot()[before:]
		if len(events) != 1 || events[0].Type != "session_model_changed" || events[0].Model != model {
			t.Fatalf("expected one change to %q, got %+v", model, events)
		}
		if seen[events[0].EventID] {
			t.Fatalf("repeated change ID when returning to %s", model)
		}
		seen[events[0].EventID] = true
		ackAllEmitted(t, cs, rec)
		before = len(rec.snapshot())
		o.pollOnce(ctx)
		if len(rec.snapshot()) != before {
			t.Fatal("unchanged poll emitted more events")
		}
	}
}
