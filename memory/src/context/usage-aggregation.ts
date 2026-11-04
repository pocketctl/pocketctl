export type UsageSignal='retrieved'|'delivered'|'agent_reported_used'|'user_confirmed'|'outcome_verified'
/** Delivery and retrieval are observations, never confirmation or authority. */
export function usageEffect(signal:UsageSignal){return{delivered:signal==='delivered',confirmed:signal==='user_confirmed'||signal==='outcome_verified',refreshAuthority:false as const}}
export const USAGE_MIGRATION_STATEMENTS=[
 `CREATE FUNCTION memory_record_delivery_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='delivered' AND OLD.state IS DISTINCT FROM 'delivered' THEN
 INSERT INTO memory_claim_usage(installation_id,claim_id,signal_key,signal,occurred_at)
 SELECT NEW.installation_id,i.claim_id,NEW.injection_id::text||':'||i.item_id::text,'delivered',COALESCE(NEW.delivered_at,clock_timestamp())
 FROM memory_context_pack_items i WHERE i.installation_id=NEW.installation_id AND i.pack_id=NEW.pack_id AND i.claim_id IS NOT NULL ON CONFLICT DO NOTHING;
 END IF;RETURN NULL;END $$`,
 `CREATE TRIGGER memory_delivery_usage AFTER UPDATE OF state ON memory_context_injections FOR EACH ROW EXECUTE FUNCTION memory_record_delivery_usage()`,
 `CREATE FUNCTION memory_record_feedback_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.action='used' THEN
 INSERT INTO memory_claim_usage(installation_id,claim_id,signal_key,signal,occurred_at)
 SELECT NEW.installation_id,i.claim_id,j.injection_id::text||':'||i.item_id::text,CASE WHEN NEW.actor='user' THEN 'user_confirmed' ELSE 'agent_reported_used' END,clock_timestamp()
 FROM memory_context_pack_items i JOIN memory_context_injections j USING(installation_id,pack_id)
 WHERE i.installation_id=NEW.installation_id AND j.state='delivered' AND (NEW.pack_id IS NULL OR i.pack_id=NEW.pack_id)
 AND (NEW.injection_id IS NULL OR j.injection_id=NEW.injection_id) AND NEW.item_id=i.item_id AND i.claim_id IS NOT NULL ON CONFLICT DO NOTHING;
 END IF;RETURN NULL;END $$`,
 `CREATE TRIGGER memory_feedback_usage AFTER INSERT ON memory_context_feedback FOR EACH ROW EXECUTE FUNCTION memory_record_feedback_usage()`,
 `CREATE FUNCTION memory_update_usage_clock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE memory_claim_lifecycle SET last_delivered_at=CASE WHEN NEW.signal='delivered' THEN GREATEST(last_delivered_at,NEW.occurred_at) ELSE last_delivered_at END,
 last_confirmed_use_at=CASE WHEN NEW.signal IN('user_confirmed','outcome_verified') THEN GREATEST(last_confirmed_use_at,NEW.occurred_at) ELSE last_confirmed_use_at END
 WHERE installation_id=NEW.installation_id AND claim_id=NEW.claim_id;
 RETURN NULL;END $$`,
 `CREATE TRIGGER memory_usage_clock AFTER INSERT ON memory_claim_usage FOR EACH ROW EXECUTE FUNCTION memory_update_usage_clock()`,
]
