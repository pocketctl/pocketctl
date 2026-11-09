/** Immutable, content-free invalidations reuse the existing durable consumer
 * watermark. Native reads need no HTTP cursor, lease or external ACK. */
export const SHARED_NATIVE_WITHDRAWAL_FUNCTIONS=[
 `CREATE OR REPLACE FUNCTION shared.memory_delivery_withdrawal_page(p_consumer UUID,p_after BIGINT,p_limit INT) RETURNS JSONB
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE items JSONB;through BIGINT;result JSONB;BEGIN
   IF p_consumer IS NULL OR p_after IS NULL OR p_after<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_native_withdrawal_page';END IF;
   SELECT COALESCE(jsonb_agg(jsonb_build_object('sequence',sequence::text,'team_id',team_id,'team_session_id',team_session_id,
    'submission_id',submission_id::text,'decision_id',decision_id::text,'recorded_at',to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY sequence),'[]'::jsonb),COALESCE(max(sequence),p_after)
    INTO items,through FROM(SELECT sequence,team_id,team_session_id,submission_id,decision_id,recorded_at FROM public.team_delivery_memory_withdrawals WHERE sequence>p_after ORDER BY sequence LIMIT p_limit) page;
   result:=jsonb_build_object('version',1,'consumer_id',p_consumer::text,'items',items,'through_sequence',through::text);
   IF octet_length(result::text)>1048576 THEN RAISE EXCEPTION 'native_withdrawal_byte_limit';END IF;RETURN result;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_delivery_withdrawal_page(UUID,BIGINT,INT) FROM PUBLIC`,
] as const
