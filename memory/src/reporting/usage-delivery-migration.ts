// Usage IDs are installation-scoped and unchanged across reporting attempts.
// A historical validation rejection still requires the exact-fact repair path.
export const USAGE_DELIVERY_ISOLATION_STATEMENTS = [
  `ALTER TABLE memory_usage_outbox ADD COLUMN received_at timestamptz, ADD COLUMN available_at timestamptz NOT NULL DEFAULT NOW(),
    ADD COLUMN delivery_claim uuid, ADD COLUMN delivery_state text NOT NULL DEFAULT 'pending'
      CHECK(delivery_state IN('pending','cooldown','probe','rejected','legacy'))`,
  `ALTER TABLE memory_usage_outbox ALTER COLUMN received_at SET DEFAULT statement_timestamp()`,
  `UPDATE memory_usage_outbox SET delivery_state=CASE WHEN last_error_code IN('network','timeout','rate_limited','relay_error')
      THEN 'probe' ELSE 'legacy' END
    WHERE dead_lettered_at IS NOT NULL AND reported_at IS NULL`,
  `CREATE INDEX memory_usage_intake ON memory_usage_outbox(installation_id,COALESCE(received_at,occurred_at) DESC)`,
  `CREATE INDEX memory_usage_delivery_due ON memory_usage_outbox(installation_id,(attempts>0),available_at,occurred_at,usage_id)
    WHERE reported_at IS NULL AND delivery_state IN('pending','cooldown','probe')`,
  `CREATE FUNCTION memory_reject_usage_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'usage_fact_is_immutable' USING ERRCODE='23514'; END $$`,
  `CREATE TRIGGER memory_reject_usage_rewrite BEFORE UPDATE OF installation_id,usage_id,operation,model,input_tokens,
    output_tokens,embedding_tokens,cached_tokens,cost_micros,occurred_at ON memory_usage_outbox FOR EACH ROW
    WHEN((OLD.installation_id,OLD.usage_id,OLD.operation,OLD.model,OLD.input_tokens,OLD.output_tokens,OLD.embedding_tokens,
      OLD.cached_tokens,OLD.cost_micros,OLD.occurred_at) IS DISTINCT FROM
      (NEW.installation_id,NEW.usage_id,NEW.operation,NEW.model,NEW.input_tokens,NEW.output_tokens,NEW.embedding_tokens,
      NEW.cached_tokens,NEW.cost_micros,NEW.occurred_at)) EXECUTE FUNCTION memory_reject_usage_rewrite()`,
  `CREATE TABLE memory_usage_delivery_schedule(
    installation_id uuid PRIMARY KEY REFERENCES memory_installations ON DELETE CASCADE,
    last_selected_at timestamptz)`,
  `CREATE INDEX memory_usage_delivery_rotation ON memory_usage_delivery_schedule(last_selected_at NULLS FIRST,installation_id)`,
  `INSERT INTO memory_usage_delivery_schedule(installation_id) SELECT DISTINCT installation_id FROM memory_usage_outbox
    WHERE reported_at IS NULL AND delivery_state IN('pending','cooldown','probe')`,
  `CREATE FUNCTION memory_register_usage_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO memory_usage_delivery_schedule(installation_id) VALUES(NEW.installation_id) ON CONFLICT DO NOTHING;
    RETURN NULL; END $$`,
  `CREATE TRIGGER memory_register_usage_delivery AFTER INSERT ON memory_usage_outbox
    FOR EACH ROW EXECUTE FUNCTION memory_register_usage_delivery()`,
  `CREATE FUNCTION memory_classify_old_usage_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.delivery_state=CASE WHEN NEW.last_error_code IN('network','timeout','rate_limited','relay_error') THEN 'probe' ELSE 'legacy' END;
      NEW.delivery_claim=NULL; NEW.available_at=clock_timestamp()+interval '1 hour'; RETURN NEW;
    END $$`,
  `CREATE TRIGGER memory_classify_old_usage_failure BEFORE INSERT OR UPDATE OF dead_lettered_at ON memory_usage_outbox
    FOR EACH ROW WHEN(NEW.dead_lettered_at IS NOT NULL AND NEW.reported_at IS NULL AND NEW.delivery_state='pending')
    EXECUTE FUNCTION memory_classify_old_usage_failure()`,
  `CREATE FUNCTION memory_requeue_reconciled_usage() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.available_at=clock_timestamp(); NEW.delivery_claim=NULL; NEW.delivery_state='pending';
      INSERT INTO memory_usage_delivery_schedule(installation_id) VALUES(NEW.installation_id) ON CONFLICT DO NOTHING;
      RETURN NEW; END $$`,
  `CREATE TRIGGER memory_requeue_reconciled_usage BEFORE UPDATE OF dead_lettered_at ON memory_usage_outbox
    FOR EACH ROW WHEN(OLD.dead_lettered_at IS NOT NULL AND NEW.dead_lettered_at IS NULL AND NEW.reported_at IS NULL)
    EXECUTE FUNCTION memory_requeue_reconciled_usage()`,
] as const
