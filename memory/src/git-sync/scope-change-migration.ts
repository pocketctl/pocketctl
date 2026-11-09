/** Keep historical migration 44 immutable. Fix existing databases additively. */
export const GIT_SCOPE_CHANGE_MIGRATION={version:85,statements:[
 `CREATE OR REPLACE FUNCTION memory_git_scope_changed() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE i UUID;c UUID; BEGIN
    i=CASE WHEN TG_OP='DELETE' THEN OLD.installation_id ELSE NEW.installation_id END;
    IF TG_OP='UPDATE' THEN
      IF TG_TABLE_NAME='memory_installations' THEN
        IF (NEW.local_status,NEW.relay_status,NEW.config_version,NEW.granted_scopes,NEW.subscriptions,NEW.enabled_services,NEW.event_filter)
          IS NOT DISTINCT FROM (OLD.local_status,OLD.relay_status,OLD.config_version,OLD.granted_scopes,OLD.subscriptions,OLD.enabled_services,OLD.event_filter)
        THEN RETURN NEW; END IF;
      ELSIF TG_TABLE_NAME='memory_owner_scopes' THEN
        IF (NEW.state,NEW.authorization_epoch,NEW.owner_scope_kind,NEW.owner_scope_id,NEW.parent_organization_id)
          IS NOT DISTINCT FROM (OLD.state,OLD.authorization_epoch,OLD.owner_scope_kind,OLD.owner_scope_id,OLD.parent_organization_id)
        THEN RETURN NEW; END IF;
      ELSE RAISE EXCEPTION 'memory_git_scope_trigger_contract'; END IF;
    END IF;
    FOR c IN SELECT k.connection_id FROM memory_git_connections k JOIN memory_owner_scopes s USING(installation_id)
      WHERE s.installation_id=i OR s.parent_organization_id IN(SELECT owner_scope_id FROM memory_owner_scopes WHERE installation_id=i AND owner_scope_kind='organization')
      ORDER BY k.connection_id LOOP
      PERFORM memory_git_invalidate_connection((SELECT installation_id FROM memory_git_connections WHERE connection_id=c),c); END LOOP;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$`,
 `DROP TRIGGER memory_git_scope_changed ON memory_owner_scopes`,
 `CREATE TRIGGER memory_git_scope_changed BEFORE UPDATE OF state,authorization_epoch,owner_scope_kind,owner_scope_id,parent_organization_id
   ON memory_owner_scopes FOR EACH ROW EXECUTE FUNCTION memory_git_scope_changed()`,
 `DROP TRIGGER memory_git_installation_changed ON memory_installations`,
 `CREATE TRIGGER memory_git_installation_changed BEFORE UPDATE OF local_status,relay_status,config_version,granted_scopes,subscriptions,enabled_services,event_filter
   ON memory_installations FOR EACH ROW EXECUTE FUNCTION memory_git_scope_changed()`,
]} as const
