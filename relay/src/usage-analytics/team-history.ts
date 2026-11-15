import type pg from 'pg'
/** Triggers cover all repository/account lifecycle paths in the same transaction.
 * Baseline is observed now, never an inferred historical join date. */
export async function initUsageTeamHistory(db:Pick<pg.Pool,'query'>){await db.query(`
 CREATE TABLE IF NOT EXISTS usage_team_binding_periods(
  period_id BIGSERIAL PRIMARY KEY,team_id TEXT NOT NULL,owner_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  daemon_id TEXT NOT NULL,from_at TIMESTAMPTZ NOT NULL,to_exclusive TIMESTAMPTZ,source_revision BIGINT NOT NULL,evidence TEXT NOT NULL,
  CHECK(to_exclusive IS NULL OR to_exclusive>=from_at));
 CREATE UNIQUE INDEX IF NOT EXISTS usage_team_binding_open ON usage_team_binding_periods(daemon_id) WHERE to_exclusive IS NULL;
 CREATE INDEX IF NOT EXISTS usage_team_binding_windows ON usage_team_binding_periods(team_id,owner_user_id,daemon_id,from_at);
 CREATE TABLE IF NOT EXISTS usage_team_membership_periods(
  period_id BIGSERIAL PRIMARY KEY,team_id TEXT NOT NULL,member_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_at TIMESTAMPTZ NOT NULL,to_exclusive TIMESTAMPTZ,source_revision BIGINT NOT NULL,evidence TEXT NOT NULL,
  CHECK(to_exclusive IS NULL OR to_exclusive>=from_at));
 CREATE UNIQUE INDEX IF NOT EXISTS usage_team_member_open ON usage_team_membership_periods(team_id,member_user_id) WHERE to_exclusive IS NULL;
 INSERT INTO usage_team_binding_periods(team_id,owner_user_id,daemon_id,from_at,source_revision,evidence)
 SELECT team_id,owner_user_id,daemon_id,clock_timestamp(),revision,'observed_baseline' FROM collaboration_team_daemon_bindings b
 WHERE NOT EXISTS(SELECT 1 FROM usage_team_binding_periods p WHERE p.daemon_id=b.daemon_id AND p.to_exclusive IS NULL);
 INSERT INTO usage_team_membership_periods(team_id,member_user_id,from_at,source_revision,evidence)
 SELECT team_id,user_id,clock_timestamp(),revision,'observed_baseline' FROM collaboration_team_memberships m WHERE state='active'
 AND NOT EXISTS(SELECT 1 FROM usage_team_membership_periods p WHERE p.team_id=m.team_id AND p.member_user_id=m.user_id AND p.to_exclusive IS NULL);
 ALTER TABLE usage_team_membership_periods ADD COLUMN IF NOT EXISTS source_joined_at TIMESTAMPTZ;
 UPDATE usage_team_membership_periods p SET source_joined_at=m.joined_at FROM collaboration_team_memberships m WHERE p.team_id=m.team_id AND p.member_user_id=m.user_id AND p.evidence='observed_baseline' AND p.source_joined_at IS NULL;
 ALTER TABLE usage_team_binding_periods ADD COLUMN IF NOT EXISTS source_created_at TIMESTAMPTZ;
 UPDATE usage_team_binding_periods p SET source_created_at=b.created_at FROM collaboration_team_daemon_bindings b WHERE p.daemon_id=b.daemon_id AND p.evidence='observed_baseline' AND p.source_created_at IS NULL;
 CREATE OR REPLACE FUNCTION usage_binding_no_overlap() RETURNS TRIGGER LANGUAGE plpgsql AS $usage$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('usage-binding:'||NEW.daemon_id,0));
 IF EXISTS(SELECT 1 FROM usage_team_binding_periods p WHERE p.daemon_id=NEW.daemon_id AND p.period_id<>NEW.period_id AND tstzrange(p.from_at,p.to_exclusive,'[)')&&tstzrange(NEW.from_at,NEW.to_exclusive,'[)')) THEN RAISE EXCEPTION 'usage_binding_overlap' USING ERRCODE='23P01';END IF;RETURN NEW;END $usage$;
 DROP TRIGGER IF EXISTS usage_binding_no_overlap ON usage_team_binding_periods;
 CREATE TRIGGER usage_binding_no_overlap BEFORE INSERT OR UPDATE ON usage_team_binding_periods FOR EACH ROW EXECUTE FUNCTION usage_binding_no_overlap();
 CREATE OR REPLACE FUNCTION usage_member_no_overlap() RETURNS TRIGGER LANGUAGE plpgsql AS $usage$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('usage-member:'||NEW.team_id||':'||NEW.member_user_id,0));
 IF EXISTS(SELECT 1 FROM usage_team_membership_periods p WHERE p.team_id=NEW.team_id AND p.member_user_id=NEW.member_user_id AND p.period_id<>NEW.period_id AND tstzrange(p.from_at,p.to_exclusive,'[)')&&tstzrange(NEW.from_at,NEW.to_exclusive,'[)')) THEN RAISE EXCEPTION 'usage_membership_overlap' USING ERRCODE='23P01';END IF;RETURN NEW;END $usage$;
 DROP TRIGGER IF EXISTS usage_member_no_overlap ON usage_team_membership_periods;
 CREATE TRIGGER usage_member_no_overlap BEFORE INSERT OR UPDATE ON usage_team_membership_periods FOR EACH ROW EXECUTE FUNCTION usage_member_no_overlap();
 CREATE OR REPLACE FUNCTION usage_binding_history() RETURNS TRIGGER LANGUAGE plpgsql AS $usage$ DECLARE at_time TIMESTAMPTZ:=clock_timestamp(); BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (OLD.team_id,OLD.owner_user_id) IS DISTINCT FROM (NEW.team_id,NEW.owner_user_id)) THEN UPDATE usage_team_binding_periods SET to_exclusive=at_time,evidence='binding_closed' WHERE daemon_id=OLD.daemon_id AND to_exclusive IS NULL;END IF;
 IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND (OLD.team_id,OLD.owner_user_id) IS DISTINCT FROM (NEW.team_id,NEW.owner_user_id)) THEN INSERT INTO usage_team_binding_periods(team_id,owner_user_id,daemon_id,from_at,source_revision,evidence,source_created_at) VALUES(NEW.team_id,NEW.owner_user_id,NEW.daemon_id,at_time,NEW.revision,'binding_changed',NEW.created_at);END IF;RETURN NULL;END $usage$;
 DROP TRIGGER IF EXISTS usage_binding_history ON collaboration_team_daemon_bindings;
 CREATE TRIGGER usage_binding_history AFTER INSERT OR UPDATE OR DELETE ON collaboration_team_daemon_bindings FOR EACH ROW EXECUTE FUNCTION usage_binding_history();
 CREATE OR REPLACE FUNCTION usage_membership_history() RETURNS TRIGGER LANGUAGE plpgsql AS $usage$ DECLARE at_time TIMESTAMPTZ:=clock_timestamp(); BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.state='active' AND NEW.state<>'active') THEN UPDATE usage_team_membership_periods SET to_exclusive=at_time,evidence='membership_closed' WHERE team_id=OLD.team_id AND member_user_id=OLD.user_id AND to_exclusive IS NULL;END IF;
 IF (TG_OP='INSERT' AND NEW.state='active') OR (TG_OP='UPDATE' AND OLD.state<>'active' AND NEW.state='active') THEN INSERT INTO usage_team_membership_periods(team_id,member_user_id,from_at,source_revision,evidence,source_joined_at) VALUES(NEW.team_id,NEW.user_id,at_time,NEW.revision,'membership_changed',NEW.joined_at);END IF;RETURN NULL;END $usage$;
 DROP TRIGGER IF EXISTS usage_membership_history ON collaboration_team_memberships;
 CREATE TRIGGER usage_membership_history AFTER INSERT OR UPDATE OR DELETE ON collaboration_team_memberships FOR EACH ROW EXECUTE FUNCTION usage_membership_history();
 `)}
