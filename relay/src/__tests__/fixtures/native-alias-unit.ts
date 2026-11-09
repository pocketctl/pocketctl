/** These SQL fakes model a fixture with no historical aliases. Ownership
 * probes continue to use each suite's existing adversarial Session model.
 * Actual alias/owner/privacy/COMMIT behavior is covered by real PG fixtures. */
export function nativeAliasUnitResult(sql:string,params:readonly any[]=[]):{rows:any[];rowCount:number}|undefined{
 if(sql==='SELECT public.native_session_alias_set($1::text[]) AS ids')return {rows:[{ids:[...new Set(params[0]??[])].sort()}],rowCount:1}
 if(sql==='SELECT public.native_session_authority($1,$2,$3) AS authority')return {rows:[{authority:{state:'current',sessionId:params[0],sessionIds:[params[0]],revision:'0',originSessionId:params[0]}}],rowCount:1}
 if(sql.startsWith('SELECT e.id::text FROM events e WHERE e.id=ANY'))return {rows:(params[0]??[]).map((id:string)=>({id:String(id)})),rowCount:(params[0]??[]).length}
 if(sql.startsWith('SELECT 1 FROM public.events WHERE id=$1::bigint AND user_id=$2'))return {rows:[{}],rowCount:1}
 return undefined
}
/** Fresh schema input for bootstrap-only SQL fakes. Historical upgrades and
 * partial native contracts are exercised against dedicated PostgreSQL. */
export function freshNativeSchemaUnitResult(sql:string):{rows:any[];rowCount:number}|undefined{
 if(sql.includes("to_regprocedure('public.native_session_authority(text,integer,text)') IS NOT NULL AS native_function"))return {rows:[{native_function:false,definition:null,aliases:false,documents:false,relay_contract:false,barriers:false}],rowCount:1}
 return undefined
}
