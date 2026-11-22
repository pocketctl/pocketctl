// Evidence can refer to both an artifact and a raw event. Record both session
// identities while the original handles can still be proved. Git withdrawal
// also reads the dialogue locator and the episode relationship directly.
export const EVIDENCE_SESSION_MIGRATION={version:107,statements:[
 `CREATE TABLE memory_evidence_source_sessions(
   installation_id UUID NOT NULL,evidence_id UUID NOT NULL,session_id TEXT NOT NULL,
   PRIMARY KEY(installation_id,evidence_id,session_id),
   FOREIGN KEY(installation_id,evidence_id) REFERENCES knowledge_evidence(installation_id,evidence_id) ON DELETE CASCADE)`,
 `CREATE INDEX memory_evidence_session_members ON memory_evidence_source_sessions(installation_id,session_id,evidence_id)`,
 `CREATE FUNCTION memory_record_evidence_source_sessions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  DELETE FROM memory_evidence_source_sessions WHERE installation_id=NEW.installation_id AND evidence_id=NEW.evidence_id;
  IF NEW.source_event_id IS NOT NULL THEN
   INSERT INTO memory_evidence_source_sessions
    SELECT NEW.installation_id,NEW.evidence_id,session_id FROM source_events
    WHERE installation_id=NEW.installation_id AND source_event_id=NEW.source_event_id AND session_id IS NOT NULL;
  END IF;
  IF NEW.artifact_id IS NOT NULL THEN
   INSERT INTO memory_evidence_source_sessions
    SELECT NEW.installation_id,NEW.evidence_id,session_id FROM source_artifacts
    WHERE installation_id=NEW.installation_id AND artifact_id=NEW.artifact_id AND session_id IS NOT NULL
    UNION SELECT a.installation_id,NEW.evidence_id,s.session_id FROM source_artifacts a JOIN source_events s USING(installation_id,source_event_id)
    WHERE a.installation_id=NEW.installation_id AND a.artifact_id=NEW.artifact_id AND s.session_id IS NOT NULL ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
 END $$`,
 `CREATE TRIGGER memory_bind_evidence_source_sessions AFTER INSERT OR UPDATE OF source_event_id,artifact_id ON knowledge_evidence
 FOR EACH ROW EXECUTE FUNCTION memory_record_evidence_source_sessions()`,
 `INSERT INTO memory_evidence_source_sessions
 SELECT e.installation_id,e.evidence_id,s.session_id FROM knowledge_evidence e JOIN source_events s USING(installation_id,source_event_id)
 WHERE s.session_id IS NOT NULL UNION
 SELECT e.installation_id,e.evidence_id,a.session_id FROM knowledge_evidence e JOIN source_artifacts a USING(installation_id,artifact_id)
 WHERE a.session_id IS NOT NULL UNION
 SELECT e.installation_id,e.evidence_id,s.session_id FROM knowledge_evidence e JOIN source_artifacts a USING(installation_id,artifact_id)
 JOIN source_events s ON s.installation_id=a.installation_id AND s.source_event_id=a.source_event_id WHERE s.session_id IS NOT NULL`,
 `CREATE OR REPLACE FUNCTION memory_git_session_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c UUID;i UUID;s TEXT; BEGIN
    i=CASE WHEN TG_OP='DELETE' THEN OLD.installation_id ELSE NEW.installation_id END;
    s=CASE WHEN TG_OP='DELETE' THEN OLD.session_id ELSE NEW.session_id END;
    FOR c IN SELECT d.connection_id FROM memory_git_snapshot_sources d JOIN work_episodes e ON e.installation_id=d.installation_id AND e.episode_id=d.episode_id
      WHERE e.installation_id=i AND e.session_id=s
      UNION SELECT d.connection_id FROM memory_git_snapshot_sources d JOIN knowledge_evidence e USING(installation_id,evidence_id)
        WHERE d.installation_id=i AND (e.locator#>>'{dialogue,session}'=s OR EXISTS(
          SELECT 1 FROM memory_evidence_source_sessions r WHERE r.installation_id=i AND r.evidence_id=e.evidence_id AND r.session_id=s))
      UNION SELECT a.connection_id FROM memory_git_snapshot_assets a JOIN memory_skill_replay_runs r ON r.installation_id=a.installation_id AND r.version_id=a.skill_version_id
        JOIN memory_skill_replay_cases k ON k.installation_id=r.installation_id AND k.run_id=r.run_id
        WHERE a.installation_id=i AND k.kind='historical_session' AND k.reference_id=s
      ORDER BY 1 LOOP PERFORM memory_git_invalidate_connection(i,c); END LOOP;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$`,
]} as const
