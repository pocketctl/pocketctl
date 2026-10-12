import type pg from 'pg'

/** Team adoption and parent bucket mutations must serialize with the same
 * fence as publication. The trigger covers non-materializer write paths. */
export async function initLifecycleDependencyFenceSchema(db:Pick<pg.Pool,'query'>):Promise<void>{
  await db.query(`CREATE OR REPLACE FUNCTION fence_lifecycle_team_binding() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE sid TEXT;
    BEGIN
      FOR sid IN SELECT DISTINCT value FROM unnest(ARRAY[NEW.native_session_id,CASE WHEN TG_OP='UPDATE' THEN OLD.native_session_id ELSE NULL END]) value
        WHERE value IS NOT NULL ORDER BY value LOOP
        PERFORM pg_advisory_xact_lock(1885566061,hashtext(sid));
        UPDATE sessions SET activity_epoch=activity_epoch+1 WHERE session_id=sid;
      END LOOP;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS lifecycle_team_binding_fence ON collaboration_session_agent_bindings;
    CREATE TRIGGER lifecycle_team_binding_fence BEFORE INSERT OR UPDATE OF native_session_id,state ON collaboration_session_agent_bindings
      FOR EACH ROW EXECUTE FUNCTION fence_lifecycle_team_binding();
    CREATE OR REPLACE FUNCTION fence_lifecycle_subagent() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE sid TEXT;
      BEGIN
        FOR sid IN SELECT DISTINCT value FROM unnest(ARRAY[NEW.parent_session_id,CASE WHEN TG_OP='UPDATE' THEN OLD.parent_session_id ELSE NULL END]) value
          WHERE value IS NOT NULL ORDER BY value LOOP
          PERFORM pg_advisory_xact_lock(1885566061,hashtext(sid));
          UPDATE sessions SET activity_epoch=activity_epoch+1 WHERE session_id=sid;
        END LOOP;
        RETURN NEW;
      END $$;
    DROP TRIGGER IF EXISTS lifecycle_subagent_fence ON subagents;
    CREATE TRIGGER lifecycle_subagent_fence BEFORE INSERT OR UPDATE OF parent_session_id,kind,status ON subagents
      FOR EACH ROW EXECUTE FUNCTION fence_lifecycle_subagent();`)
}
