package session

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// confirmWorkerStop never discovers a target from "latest chat". It uses the
// digest-verified original room and durably stores the observed running UUID
// before issuing a stop. Missing/pending chat is not a confirmed stop.
func (e *AgentTeamsExecutor) confirmWorkerStop(ctx context.Context, id ExternalExecutionIdentity) error {
	if e.worker == nil {
		return ErrExternalUnknown
	}
	room, err := e.taskRoom(ctx, id)
	if err != nil {
		return err
	}
	chat, err := e.worker.Chat(ctx, room)
	if err != nil {
		return errors.Join(ErrExternalUnknown, err)
	}
	var savedRoom, savedChat, previous, finished string
	var confirmed bool
	err = e.journal.db.QueryRowContext(ctx, `SELECT room_id,chat_id,previous_finished_at,finished_at,confirmed FROM agentteams_stop_intents WHERE call_id=?`, id.CallID).Scan(&savedRoom, &savedChat, &previous, &finished, &confirmed)
	if errors.Is(err, sql.ErrNoRows) {
		if chat.Status != "running" {
			return ErrExternalUnknown
		}
		_, err = e.journal.db.ExecContext(ctx, `INSERT INTO agentteams_stop_intents(call_id,room_id,chat_id,previous_finished_at,finished_at,confirmed) VALUES(?,?,?,?,'',0) ON CONFLICT DO NOTHING`, id.CallID, room, chat.ID, chat.LastFinishedAt)
		if err != nil {
			return err
		}
		return e.confirmWorkerStop(ctx, id)
	}
	if err != nil {
		return err
	}
	if savedRoom != room || savedChat != chat.ID {
		return ErrExternalIdentity
	}
	if chat.Status == "idle" {
		// A confirmed stop is re-observed, not blindly replayed. An unknown reply
		// can reconcile only after this originally-running chat records completion.
		if !confirmed {
			ended, parseErr := time.Parse(time.RFC3339Nano, chat.LastFinishedAt)
			if parseErr != nil {
				return ErrExternalUnknown
			}
			if previous != "" {
				old, parseErr := time.Parse(time.RFC3339Nano, previous)
				if parseErr != nil || !ended.After(old) {
					return ErrExternalUnknown
				}
			}
		} else if chat.LastFinishedAt != finished {
			return ErrExternalUnknown
		}
	} else {
		chat, err = e.worker.StopChat(ctx, room, savedChat)
		if err != nil {
			return errors.Join(ErrExternalUnknown, err)
		}
	}
	_, err = e.journal.db.ExecContext(ctx, `UPDATE agentteams_stop_intents SET confirmed=1,finished_at=? WHERE call_id=? AND room_id=? AND chat_id=?`, chat.LastFinishedAt, id.CallID, room, savedChat)
	return err
}
