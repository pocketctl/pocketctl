import type pg from 'pg'
import {canonicalJsonString} from '@pocketctl/session-source'
import type {TeamSemanticRoster} from './team-semantic-discovery.js'
/** Body-free original relation snapshot. IDs belong only to this receiving
 * installation. Foreign/global accounting is represented by an opaque bounded
 * manifest; it never acquires an owner from budget keys, clocks or body hashes. */
export type LegacyRelationKind='source'|'turn'|'episode'|'extraction'|'generation'|'candidate'|'task'|'curation'|'version'|'evidence'|'capsule'|'usage'
export interface TeamSemanticLegacyAudit {
 version:1;disposition:'fresh_candidate'|'related'|'unproven';closure:'snapshot_only';identityDigest:string;closureDigest:string
 relations:[LegacyRelationKind,string,string,string][]
 accounting:{version:1;digest:string;count:number;unprovenCount:number;relatedCount:number}
 reasons:('relation_unknown'|'relation_limit'|'global_accounting_unbound')[]
}
/** The same controlled SQL collector serves preparation and deferred COMMIT.
 * Snapshot completeness is deliberately distinct from a global writer fence. */
export async function collectTeamSemanticLegacyAudit(client:Pick<pg.Pool,'query'>,r:TeamSemanticRoster):Promise<TeamSemanticLegacyAudit>{
 const audit=(await client.query('SELECT shared.read_memory_team_legacy_audit($1,$2::jsonb) AS audit',[r.installationId,JSON.stringify(r)])).rows[0]?.audit
 if(!audit||audit.version!==1||audit.closure!=='snapshot_only'||!['fresh_candidate','related','unproven'].includes(audit.disposition)
  ||typeof audit.identityDigest!=='string'||!/^[a-f0-9]{64}$/.test(audit.identityDigest)||!Array.isArray(audit.relations)||audit.relations.length>4096
  ||Buffer.byteLength(canonicalJsonString(audit))>2*1024*1024)throw Error('team_semantic_legacy_audit_unproven')
 return audit
}
/** Finite SQL JSON contract. Nested relations are fixed typed tuples, so no
 * arbitrary object keys, body fields or request-key fields can be introduced. */
export const TEAM_SEMANTIC_LEGACY_AUDIT_CHECK=`COALESCE(
 jsonb_typeof(legacy_relation_audit)='object' AND octet_length(legacy_relation_audit::text)<=2097152
 AND legacy_relation_audit ?& ARRAY['version','closure','disposition','identityDigest','closureDigest','relations','accounting','reasons']
 AND legacy_relation_audit-ARRAY['version','closure','disposition','identityDigest','closureDigest','relations','accounting','reasons']='{}'::jsonb
 AND legacy_relation_audit->'version'='1'::jsonb AND legacy_relation_audit->>'closure'='snapshot_only'
 AND legacy_relation_audit->>'disposition' IN('fresh_candidate','related','unproven')
 AND jsonb_typeof(legacy_relation_audit->'identityDigest')='string' AND legacy_relation_audit->>'identityDigest' ~ '^[a-f0-9]{64}$'
 AND jsonb_typeof(legacy_relation_audit->'closureDigest')='string' AND legacy_relation_audit->>'closureDigest' ~ '^[a-f0-9]{64}$'
 AND jsonb_typeof(legacy_relation_audit->'relations')='array' AND jsonb_array_length(legacy_relation_audit->'relations')<=4096
 AND NOT jsonb_path_exists(legacy_relation_audit,'strict $.relations[*] ? (@.type() != "array" || @.size() != 4 || @ [0].type() != "string" || !(@ [0] == "source" || @ [0] == "turn" || @ [0] == "episode" || @ [0] == "extraction" || @ [0] == "generation" || @ [0] == "candidate" || @ [0] == "task" || @ [0] == "curation" || @ [0] == "version" || @ [0] == "evidence" || @ [0] == "capsule" || @ [0] == "usage") || @ [1].type() != "string" || !(@ [1] like_regex "^.{1,255}.{0,255}.{0,255}.{0,255}.{0,4}$") || @ [2].type() != "string" || !(@ [2] like_regex "^[a-f0-9]{64}$") || @ [3].type() != "string" || !(@ [3] like_regex "^[a-z_]{1,64}$"))')
 AND jsonb_typeof(legacy_relation_audit->'reasons')='array' AND jsonb_array_length(legacy_relation_audit->'reasons')<=3
 AND NOT jsonb_path_exists(legacy_relation_audit,'strict $.reasons[*] ? (!(@ == "relation_unknown" || @ == "relation_limit" || @ == "global_accounting_unbound"))')
 AND jsonb_typeof(legacy_relation_audit->'accounting')='object'
 AND legacy_relation_audit->'accounting' ?& ARRAY['version','digest','count','unprovenCount','relatedCount']
 AND (legacy_relation_audit->'accounting')-ARRAY['version','digest','count','unprovenCount','relatedCount']='{}'::jsonb
 AND legacy_relation_audit->'accounting'->'version'='1'::jsonb
 AND jsonb_typeof(legacy_relation_audit->'accounting'->'digest')='string' AND legacy_relation_audit->'accounting'->>'digest' ~ '^[a-f0-9]{64}$'
 AND ${['count','unprovenCount','relatedCount'].map(k=>`jsonb_typeof(legacy_relation_audit->'accounting'->'${k}')='number' AND legacy_relation_audit->'accounting'->>'${k}' ~ '^(0|[1-9][0-9]{0,6})$'`).join(' AND ')}
,FALSE)`
