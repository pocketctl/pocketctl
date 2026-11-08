import {installRetainedInputStartFixture} from './input-start-fixture.js'
import type pg from 'pg'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {stat} from 'node:fs/promises'
/** Upgrade the older independent reader/control fixtures with the actual
 * native Relay installer. This is fixture DDL, never a runtime schema fallback.
 * Their intentionally corrupt storage-head cases still test reader defenses;
 * the full native suite independently exercises production body tuple FKs. */
export async function installNativeAliasFixture(pool:Pick<pg.Pool,'query'>,options:{inputPolicy?:'retained_history';inputFoundation?:object}={}):Promise<void>{
 const source=resolve('../relay/src/session-alias/schema.ts'),built=resolve('../relay/dist/session-alias/schema.js')
 if((await stat(source)).mtimeMs>(await stat(built)).mtimeMs)throw Error('native_alias_fixture_build_stale')
 await pool.query(`
  ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS activity_epoch BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS last_business_activity_at TIMESTAMPTZ;
  ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  CREATE TABLE IF NOT EXISTS public.events(id BIGINT PRIMARY KEY,session_id TEXT,user_id INT,event_type TEXT,payload JSONB,effect_status TEXT DEFAULT 'completed');
  ALTER TABLE public.events ADD COLUMN IF NOT EXISTS body_storage TEXT DEFAULT 'hot';
  ALTER TABLE public.events ADD COLUMN IF NOT EXISTS body_manifest_id UUID;
  ALTER TABLE public.events ADD COLUMN IF NOT EXISTS body_chunk_ordinal INT;
  ALTER TABLE public.events ADD COLUMN IF NOT EXISTS body_activity_epoch BIGINT;
  ALTER TABLE public.events ADD COLUMN IF NOT EXISTS body_owner_user_id INT;
  ALTER TABLE public.events ADD COLUMN IF NOT EXISTS body_session_id TEXT;
  CREATE TABLE IF NOT EXISTS public.session_archive_manifests(manifest_id UUID PRIMARY KEY,user_id INT,session_id TEXT,activity_epoch BIGINT,schema_version INT,codec TEXT,state TEXT,storage_namespace TEXT);
  ALTER TABLE public.session_archive_manifests ADD COLUMN IF NOT EXISTS operation_id UUID;
  CREATE TABLE IF NOT EXISTS public.session_message_admissions(session_id TEXT,canonical_session_id TEXT,user_id INT,daemon_id TEXT,session_aliases JSONB NOT NULL DEFAULT '[]');
  UPDATE public.events e SET body_session_id=m.session_id FROM public.session_archive_manifests m
   WHERE e.body_storage='cold' AND e.body_session_id IS NULL AND e.body_manifest_id=m.manifest_id
    AND e.body_owner_user_id=m.user_id AND e.session_id=m.session_id AND e.body_activity_epoch=m.activity_epoch;
  CREATE OR REPLACE FUNCTION public.bind_legacy_fixture_body_session() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
   IF NEW.body_storage='cold' AND NEW.body_session_id IS NULL THEN
    SELECT m.session_id INTO NEW.body_session_id FROM public.session_archive_manifests m WHERE m.manifest_id=NEW.body_manifest_id
     AND m.session_id=NEW.session_id AND m.user_id=NEW.body_owner_user_id AND m.activity_epoch=NEW.body_activity_epoch AND m.state='published';
    IF NEW.body_session_id IS NULL THEN RAISE EXCEPTION 'fixture cold tuple unproved';END IF;
   END IF;RETURN NEW;
  END $$;
  DROP TRIGGER IF EXISTS legacy_fixture_body_session ON public.events;
  CREATE TRIGGER legacy_fixture_body_session BEFORE INSERT OR UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.bind_legacy_fixture_body_session();
 `)
 const {initNativeSessionAliasSchema}=await import(pathToFileURL(built).href)
 await initNativeSessionAliasSchema(pool)
 if(options.inputPolicy)await installRetainedInputStartFixture(pool,options.inputPolicy,options.inputFoundation)
}
