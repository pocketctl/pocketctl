import type pg from 'pg'

/** Business activity and restoration are deliberately distinct. Discovery,
 * history reads, title edits and manual unarchive cannot fire this transition. */
export async function initLifecycleResumeSchema(db:Pick<pg.Pool,'query'>):Promise<void>{
  await db.query(`CREATE OR REPLACE FUNCTION resume_session_lifecycle() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE operation UUID; notification UUID; host_name TEXT;
    BEGIN
      IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.daemon_id IS DISTINCT FROM OLD.daemon_id
        OR NEW.parent_session_id IS DISTINCT FROM OLD.parent_session_id OR NEW.root_session_id IS DISTINCT FROM OLD.root_session_id
        OR NEW.control_mode IS DISTINCT FROM OLD.control_mode OR NEW.status IS DISTINCT FROM OLD.status
        OR (NEW.archive_reason='manual' AND OLD.archive_reason IS DISTINCT FROM 'manual') THEN
        NEW.activity_epoch=GREATEST(NEW.activity_epoch,OLD.activity_epoch+1);
      END IF;
      IF NEW.last_business_activity_at IS NULL OR NEW.last_business_activity_at<=COALESCE(OLD.last_business_activity_at,'-infinity'::timestamptz)
        OR OLD.content_state IN ('deleting','deleted') THEN RETURN NEW; END IF;
      NEW.activity_epoch=GREATEST(NEW.activity_epoch,OLD.activity_epoch+1);
      IF OLD.archive_reason='inactivity' THEN NEW.archived_at=NULL;NEW.archive_reason=NULL;NEW.organization_revision=OLD.organization_revision+1; END IF;
      IF OLD.content_state IN ('cold','cooling') THEN NEW.content_state='mixed';NEW.cooling_operation_id=NULL; END IF;
      UPDATE session_lifecycle_jobs SET state='cancelled',result='{"reason":"business_activity"}'::jsonb,
        lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=NOW()
        WHERE session_id=OLD.session_id AND activity_epoch<NEW.activity_epoch AND state IN ('queued','running','partial','failed');
      IF OLD.archive_reason IS DISTINCT FROM 'inactivity' AND OLD.content_state NOT IN ('cold','cooling') THEN RETURN NEW; END IF;
      SELECT COALESCE(alias,hostname,daemon_id) INTO host_name FROM daemons WHERE daemon_id=NEW.daemon_id AND user_id=NEW.user_id;
      IF host_name IS NULL THEN RETURN NEW; END IF;
      operation=gen_random_uuid();notification=gen_random_uuid();
      INSERT INTO session_lifecycle_jobs(operation_id,user_id,session_id,action,policy_version,activity_epoch,state,result)
        VALUES(operation,NEW.user_id,NEW.session_id,'resume','session-lifecycle-v1',NEW.activity_epoch,'succeeded','{"reason":"business_activity"}');
      INSERT INTO session_lifecycle_results(operation_id,user_id,session_id,daemon_id,title_snapshot,daemon_name_snapshot,action,state,activity_at,
        executed_at,effective_purge_at,reason_code,stages,notification_id,notification_revision)
        VALUES(operation,NEW.user_id,NEW.session_id,NEW.daemon_id,left(COALESCE(NEW.title,''),512),left(host_name,255),'resume','succeeded',NEW.last_activity_at,
          NOW(),NEW.last_activity_at+interval '90 days','business_activity','{"resume":"succeeded","cold_history":"succeeded"}',notification,1);
      INSERT INTO attention_notifications(notification_id,user_id,expires_at,completed_at) VALUES(notification,NEW.user_id,NOW()+interval '90 days',NOW());
      INSERT INTO attention_notification_subjects(subject_id,notification_id,user_id,operation_id,session_id,daemon_id,title_snapshot,daemon_name_snapshot,
        action,state,activity_at,executed_at,effective_purge_at,reason_code)
        SELECT gen_random_uuid(),notification,user_id,operation_id,session_id,daemon_id,title_snapshot,daemon_name_snapshot,action,state,activity_at,
          executed_at,effective_purge_at,reason_code FROM session_lifecycle_results WHERE operation_id=operation;
      INSERT INTO notification_delivery_outbox(user_id,notification_id,revision,operation) VALUES(NEW.user_id,notification,1,'changed');
      PERFORM pg_notify('pocketctl_attention',json_build_object('entity','notification','user_id',NEW.user_id,'item_id',notification,'revision',1,'operation','changed')::text);
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS session_lifecycle_resume ON sessions;
    CREATE TRIGGER session_lifecycle_resume BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION resume_session_lifecycle();
    CREATE OR REPLACE FUNCTION notify_session_lifecycle_state() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id IS NOT NULL AND (NEW.archived_at IS DISTINCT FROM OLD.archived_at OR NEW.archive_reason IS DISTINCT FROM OLD.archive_reason OR NEW.content_state IS DISTINCT FROM OLD.content_state) THEN
        PERFORM pg_notify('pocketctl_attention',json_build_object('entity','organization','user_id',NEW.user_id,'item_id',NEW.session_id,
          'revision',NEW.organization_revision,'operation','changed')::text);
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS session_lifecycle_state_notify ON sessions;
    CREATE TRIGGER session_lifecycle_state_notify AFTER UPDATE OF archived_at,archive_reason,content_state ON sessions
      FOR EACH ROW EXECUTE FUNCTION notify_session_lifecycle_state();`)
}
