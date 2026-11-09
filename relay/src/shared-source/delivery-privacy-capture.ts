import type pg from 'pg'
const tables=['team_artifact_revocations','team_delivery_memory_withdrawals'] as const
const receiptTable='team_delivery_memory_sources',receiptTrigger='memory_delivery_source_set_fence'
export const DELIVERY_PRIVACY_EXPECTED=tables.map(table=>`('public.${table}','memory_delivery_privacy_fence','shared.fence_memory_delivery_withdrawal()',31)`).join(',')+`,('public.${receiptTable}','${receiptTrigger}','shared.fence_memory_delivery_withdrawal()',31)`
export async function assertRelayDeliveryPrivacyCapture(db:Pick<pg.Pool,'query'>){
 const marker=(await db.query("SELECT to_jsonb(c)->>'delivery_privacy_capture_version' AS version,to_jsonb(c)->>'delivery_source_set_capture_version' AS source_set_version FROM shared.memory_source_contract c")).rows
 const missing=(await db.query(`SELECT 1 FROM(VALUES ${DELIVERY_PRIVACY_EXPECTED}) r(relation,trigger_name,fn,kind)
  WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(r.relation) AND t.tgname=r.trigger_name AND t.tgfoid=to_regprocedure(r.fn) AND t.tgtype=r.kind AND t.tgenabled IN('O','A')) LIMIT 1`)).rowCount
 if(marker.length!==1||marker[0].version!=='1'||missing)throw Error('relay_delivery_privacy_capture_required')
 if(marker[0].source_set_version!=='1')throw Error('relay_delivery_source_set_capture_required')
}
/** Caller owns the explicit migration transaction. No runtime DDL. */
export async function installRelayDeliveryPrivacyCapture(db:Pick<pg.Pool,'query'>){
 const versions=(await db.query("SELECT COALESCE(to_jsonb(c)->>'delivery_privacy_capture_version','0') AS version,COALESCE(to_jsonb(c)->>'delivery_source_set_capture_version','0') AS source_set_version FROM shared.memory_source_contract c")).rows
 if(versions.length!==1||!['0','1'].includes(versions[0].version))throw Error('unsupported_delivery_privacy_capture_contract')
 if(!['0','1'].includes(versions[0].source_set_version))throw Error('unsupported_delivery_source_set_capture_contract')
 for(const table of [...tables,receiptTable])if(!(await db.query('SELECT to_regclass($1) IS NOT NULL AS present',['public.'+table])).rows[0].present)throw Error('delivery_privacy_capture_schema_required')
 if(!(await db.query("SELECT to_regprocedure('shared.fence_memory_delivery_withdrawal()') IS NOT NULL AS present")).rows[0].present)throw Error('delivery_privacy_fence_required')
 await db.query('ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS delivery_privacy_capture_version INT NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS delivery_source_set_capture_version INT NOT NULL DEFAULT 0')
 for(const table of tables)await db.query(`DROP TRIGGER IF EXISTS memory_delivery_privacy_fence ON public.${table};
  CREATE TRIGGER memory_delivery_privacy_fence BEFORE INSERT OR UPDATE OR DELETE ON public.${table} FOR EACH ROW EXECUTE FUNCTION shared.fence_memory_delivery_withdrawal()`)
 // Freeze the entire submission receipt set, including an absent reader root.
 // The existing withdrawal namespace also covers old/new submission rekeys.
 await db.query(`DROP TRIGGER IF EXISTS ${receiptTrigger} ON public.${receiptTable};
  CREATE TRIGGER ${receiptTrigger} BEFORE INSERT OR UPDATE OR DELETE ON public.${receiptTable} FOR EACH ROW EXECUTE FUNCTION shared.fence_memory_delivery_withdrawal()` )
 await db.query('UPDATE shared.memory_source_contract SET delivery_privacy_capture_version=1,delivery_source_set_capture_version=1 WHERE singleton')
 await assertRelayDeliveryPrivacyCapture(db)
}
