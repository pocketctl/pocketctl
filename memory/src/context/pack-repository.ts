import {preparedSourceUnavailable} from '../sources/prepared-sources.js'
import {guardRetainedVersions} from '../sources/retained-versions.js'
import {assertRetainedSourceGuards,detachRetainedSourceGuards} from '../sources/retained-authority.js'
import {retainedSourceRead} from '../sources/retained-read.js'
import {requireCurrentScopePermission,requireCurrentInstallationAuthority,TargetBindingError,type V2GrantFacts} from '../governance/authorization.js'
import {prepareEvidenceSources,attachPreparedEvidence,type PreparedEvidenceSources} from '../sources/evidence-sources.js'
import {isPhysicalSourcePool,sourcePoolContext} from '../sources/pool-context.js'
import {lifecycleFrameCurrent,lifecycleFrameFenceSql} from './lifecycle-frame.js'
import {captureEvidenceReferences} from '../claims/evidence-resolver.js'
import {selectedScopeContextCurrent,selectedScopeFenceSql,selectedScopeOriginFences} from './selected-scope-dependencies.js'
import {originPolicyFenceSql,lockOriginPolicyFences} from '../governance/origin-policy.js'
import {originPolicyCorpusSnapshot,originPolicyCorpusVersionsSql} from '../governance/origin-policy.js'
import {ContextConsumptionChangedError} from './consumption.js'
import { createHash } from 'crypto'
import type pg from 'pg'
import type pgPool from 'pg'
import { renderPackText, hashPackText, stableDynamicSplit, type RenderItem } from './renderer.js'
import { estimateTokens } from './token-budget.js'
import {fenceConsumptionGeneration,type ContextQueryFrame} from './consumption.js'

const machineVersionSql=`(v.authority='machine_concluded' OR EXISTS (
 SELECT 1 FROM knowledge_evidence_capsules cap WHERE cap.installation_id=v.installation_id
 AND cap.version_id=v.version_id AND cap.retention_basis='automation_conclusion'))`

const machinePackItemVersionsSql=`
 SELECT v.version_id::text FROM memory_context_pack_items i
 JOIN knowledge_versions v USING(installation_id,version_id)
 WHERE i.installation_id=p.installation_id AND i.pack_id=p.pack_id AND ${machineVersionSql}`
const recordedMachinePackVersionsSql=
 "SELECT jsonb_array_elements_text(COALESCE(p.query_context->'machineSourceVersionIds','[]'::jsonb))"
// Only for a pack whose stored selected_references is an empty array.
export const DIRECT_MACHINE_PACK_VERSIONS_SQL=`${machinePackItemVersionsSql} UNION ALL ${recordedMachinePackVersionsSql}`

// p is the authenticated pack. Wiki text can include a cited machine Claim
// through its build dependencies without a memory_context_pack_items row.
export const MACHINE_PACK_VERSIONS_SQL=`
 ${machinePackItemVersionsSql}
 UNION
 SELECT ref.source_version::text FROM jsonb_to_recordset(COALESCE(p.selected_references,'[]'::jsonb))
  ref(source_kind text,source_version uuid,installation_id uuid)
 LEFT JOIN knowledge_versions v ON v.installation_id=ref.installation_id AND v.version_id=ref.source_version
 WHERE ref.source_kind IN('memory_claim','memory_evidence') AND ref.installation_id=p.installation_id
  AND (v.version_id IS NULL OR ${machineVersionSql})
 UNION
 SELECT v.version_id::text FROM jsonb_to_recordset(COALESCE(p.selected_references,'[]'::jsonb))
  ref(source_kind text,source_version uuid,installation_id uuid)
 JOIN memory_wiki_versions w ON w.installation_id=ref.installation_id AND w.wiki_version_id=ref.source_version
 JOIN memory_wiki_build_sources bs ON bs.installation_id=w.installation_id AND bs.run_id=w.build_run_id
  AND bs.source_kind IN('claim_version','evidence')
 LEFT JOIN knowledge_evidence e ON e.installation_id=bs.installation_id AND e.evidence_id=bs.source_ref_id AND bs.source_kind='evidence'
 JOIN knowledge_versions v ON v.installation_id=bs.installation_id
  AND v.version_id=CASE WHEN bs.source_kind='claim_version' THEN bs.source_ref_id ELSE e.version_id END
 WHERE ref.source_kind='wiki_section' AND ref.installation_id=p.installation_id AND ${machineVersionSql}
 UNION
 ${recordedMachinePackVersionsSql}`

/** Recheck automated conclusions before serving saved Context in the current
 * transaction. Only the native source fence can rule out a late Relay deletion. */
export async function fenceMachinePackSources(client:Pick<pg.PoolClient,'query'>,installationId:string,packId:string,authorityGrant?:PackAuthorityGrant,boundedTransaction=false):Promise<string[]>{
 if(sourcePoolContext(client).namespace!=='memory')return []
 if(!boundedTransaction)await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
 const versions=(await client.query<{version_id:string}>(`
  SELECT source.version_id FROM memory_context_packs p
  CROSS JOIN LATERAL (${MACHINE_PACK_VERSIONS_SQL} ORDER BY 1 LIMIT 513) source
  WHERE p.installation_id=$1 AND p.pack_id=$2`,[installationId,packId])).rows
 const versionIds=versions.map(row=>row.version_id)
 if(!versionIds.length)return []
 if(authorityGrant){
  if('scopeBindings' in authorityGrant)await requireCurrentScopePermission({client:client as pg.PoolClient,grant:authorityGrant,targetInstallationId:installationId,permission:'read'})
  else{
   if(authorityGrant.installationId!==installationId)throw new TargetBindingError('installation authority mismatch')
   await requireCurrentInstallationAuthority(client as pg.PoolClient,authorityGrant,{readOnly:true})
  }
 }
 await guardRetainedVersions(client,installationId,versionIds,{requireCurrent:true,requireAvailable:true})
 await assertRetainedSourceGuards(client)
 return versionIds
}

/** A denied pack can retain its history without exposing the stored text or
 * leaving the surrounding read/consume transaction aborted. */
export async function machinePackSourcesAvailable(client:Pick<pg.PoolClient,'query'>,installationId:string,packId:string,authorityGrant?:PackAuthorityGrant):Promise<boolean>{
 if(sourcePoolContext(client).namespace!=='memory')return true
 await client.query('SAVEPOINT machine_pack_source')
 try{
  await fenceMachinePackSources(client,installationId,packId,authorityGrant)
  await client.query('RELEASE SAVEPOINT machine_pack_source')
  // The successful check holds its native and row locks until outer COMMIT.
  detachRetainedSourceGuards(client)
  return true
 }catch(error){
  await client.query('ROLLBACK TO SAVEPOINT machine_pack_source')
  await client.query('RELEASE SAVEPOINT machine_pack_source')
  detachRetainedSourceGuards(client)
  if(error instanceof TargetBindingError||preparedSourceUnavailable(error)||['55P03','57014'].includes((error as {code?:string}).code??''))return false
  throw error
 }
}

/**
 * Immutable Context Pack persistence (plan 8.2/9.4). Packs are write-once:
 * a recompile creates a new pack/run; invalidation marks state without ever
 * editing historical content.
 */

export interface PackItemInput {
  itemId: string
  claimId: string
  versionId: string
  claimType: string
  layer: 'L2' | 'L3'
  section: 'stable' | 'dynamic'
  representation: 'summary' | 'on_demand' | 'reference'
  statement: string
  scopeKind: string
  reasonCodes: string[]
  evidenceIds: readonly string[]
}

export interface ExternalPackItemInput {
  ownerScopeId?:string
  installationId?:string
  itemId: string
  versionId: string
  statement: string
  scopeKind: string
  section: 'stable' | 'dynamic'
  evidenceIds: readonly string[]
}

export type PackAuthorityGrant=V2GrantFacts|{installationId:string;configVersion:string;expiresAt?:number;userId?:number}

export interface PersistPackInput {
  /** Verified request authority, kept in memory and never persisted as a bearer. */
  authorityGrant?:PackAuthorityGrant
  installationId: string
  generationRunId: string | null
  trajectoryId: string | null
  sessionId: string
  clientRequestId: string
  agent: string
  repositoryId: string | null
  queryContext?:ContextQueryFrame
  consumptionGeneration?:string
  mode: 'shadow' | 'enabled'
  effectivePolicyHash: Buffer
  settingsFingerprint: Buffer
  loadoutFingerprint: Buffer
  inputDigest: Buffer
  policyRevision: number
  settingsRevision: number
  loadoutRevision: number
  items: readonly PackItemInput[]
  externalItems?: readonly ExternalPackItemInput[]
  selectedReferences?: readonly unknown[]
  state: 'ready' | 'shadow' | 'empty'
  errorCode?: string | null
}

const FOREIGN_PACK_SQL="(p.query_context ? 'selectedScopeProof' OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p.selected_references,'[]'::jsonb)) r WHERE r->>'installation_id' IS DISTINCT FROM p.installation_id::text))"

export type ContextPackPersistPhase =
  | 'persist_prepare' | 'persist_connect' | 'persist_authority' | 'persist_insert'
  | 'persist_fence' | 'persist_evidence_commit' | 'persist_commit'

type ObservePackPersistence = (phase: ContextPackPersistPhase, ms: number) => void

export function createPackRepository(pool: pg.Pool) {
  type StoredTokens = { stable_tokens: number; dynamic_tokens: number; evidence_proven?: boolean }
  const boundedTransaction = isPhysicalSourcePool(pool)
  const repository = {
    async persistWithSummary(input: PersistPackInput, observe?: ObservePackPersistence): Promise<{ packId: string; stableTokens: number; dynamicTokens: number; evidenceProven?: boolean }> {
      let checkpoint = observe ? performance.now() : 0
      const mark = (phase: ContextPackPersistPhase) => {
        if (!observe) return
        const now = performance.now()
        const elapsed = Math.round(now - checkpoint)
        checkpoint = now
        // Timing diagnostics cannot change a pack write or its commit result.
        try { observe(phase, elapsed) } catch { /* best-effort diagnostics */ }
      }
      const stableItems: RenderItem[] = input.items
        .filter(item => item.section === 'stable')
        .map(item => ({ ...item, evidenceIds: item.evidenceIds }))
      stableItems.push(...(input.externalItems ?? [])
        .filter(item => item.section === 'stable')
        .map(item => ({ ...item, claimId: item.itemId, evidenceIds: item.evidenceIds })))
      const dynamicItems: RenderItem[] = input.items
        .filter(item => item.section === 'dynamic')
        .map(item => ({ ...item, evidenceIds: item.evidenceIds }))
      dynamicItems.push(...(input.externalItems ?? [])
        .filter(item => item.section === 'dynamic')
        .map(item => ({ ...item, claimId: item.itemId, evidenceIds: item.evidenceIds })))
      const packDigest = createHash('sha256')
        .update([
          input.installationId, input.sessionId, input.clientRequestId,
          input.effectivePolicyHash.toString('hex'), input.inputDigest.toString('hex'),
        ].join('\n'))
        .digest().subarray(0, 16)
      // Preserve deterministic identity while setting RFC 4122 version and
      // variant bits. API UUID validation must never fail based on random hash
      // nibbles (the old raw 128-bit digest failed intermittently).
      packDigest[6] = (packDigest[6] & 0x0f) | 0x50
      packDigest[8] = (packDigest[8] & 0x3f) | 0x80
      const hex = packDigest.toString('hex')
      const packId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      const fullText = renderPackText({ packId, stable: stableItems, dynamic: dynamicItems })
      const { stable, dynamic } = stableDynamicSplit(fullText)
      const evidence = input.items.flatMap(item => item.evidenceIds.map(evidenceId => ({
        itemId: item.itemId, evidenceId, versionId: item.versionId,
      })))
      const prepared=sourcePoolContext(pool).namespace==='memory'?await prepareEvidenceSources(pool,input.installationId,[...new Set(evidence.map(ref=>ref.evidenceId))]):undefined
      mark('persist_prepare')
      const client = await pool.connect()
      let lockedEvidence:Awaited<ReturnType<PreparedEvidenceSources['lockForPack']>>|undefined
      let commitDispatched = false
      try {
        mark('persist_connect')
        await client.query(boundedTransaction ? "BEGIN; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'" : 'BEGIN')
        if(prepared){
          const grant=input.authorityGrant
          if(!grant)throw new ContextConsumptionChangedError()
          try{
            if('scopeBindings' in grant)await requireCurrentScopePermission({client,grant,targetInstallationId:input.installationId,permission:'read'})
            else{
              if(grant.installationId!==input.installationId)throw new ContextConsumptionChangedError()
              await requireCurrentInstallationAuthority(client,grant)
            }
          }catch(error){if(error instanceof TargetBindingError)throw new ContextConsumptionChangedError();throw error}
          lockedEvidence=await prepared.lockForPack(client);attachPreparedEvidence(client,prepared)
        }
        mark('persist_authority')
        const humanCapsules=lockedEvidence?.humanCapsules
        const lockedReferences=humanCapsules&&evidence.length ? evidence.map(ref=>{
          const proof=humanCapsules.get(ref.evidenceId.toLowerCase())
          const bound=proof?.versionId===ref.versionId.toLowerCase()?proof:null
          return {
            item_id:ref.itemId,evidence_id:ref.evidenceId,version_id:bound?.versionId??null,
            excerpt_hash:bound?.excerptHash.toString('hex')??null,source_version:bound?.sourceVersion??null,
          }
        }) : undefined
        // Exact reviewed capsule bindings are already locked. Chain evidence
        // and generation writes through the pack items in the same statement.
        const inserted=await client.query<StoredTokens>(`
          WITH stored AS (
            INSERT INTO memory_context_packs
              (pack_id, installation_id, generation_run_id, trajectory_id, session_id, client_request_id,
               agent, repository_id, mode, effective_policy_hash, settings_fingerprint,
               loadout_fingerprint, input_digest, policy_revision, settings_revision, loadout_revision, stable_text, dynamic_text,
               stable_hash, dynamic_hash, stable_tokens, dynamic_tokens,
               stable_cache_hit, state, error_code, selected_references,query_context, generated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                    $16, $17, $18, $19, $20, $21, $22, FALSE, $23, $24, $25::jsonb,$26::jsonb, NOW())
            ON CONFLICT DO NOTHING RETURNING pack_id, stable_tokens, dynamic_tokens
          ), items AS (
            INSERT INTO memory_context_pack_items
              (pack_id, item_id, installation_id, claim_id, version_id, claim_type,
               layer, section, representation, rendered_text, reason_codes, token_count, ordinal)
            SELECT COALESCE((SELECT pack_id FROM stored),$1::uuid), i.item_id, $2, i.claim_id, i.version_id, i.claim_type,
              i.layer, i.section, i.representation, i.rendered_text, i.reason_codes, i.token_count, i.ordinal
            FROM jsonb_to_recordset($27::jsonb) AS i(item_id uuid, claim_id uuid, version_id uuid, claim_type text,
              layer text, section text, representation text, rendered_text text, reason_codes text[], token_count integer, ordinal integer)
            ORDER BY i.ordinal
            ON CONFLICT DO NOTHING RETURNING item_id
          )${lockedReferences ? `, evidence_written AS (
            INSERT INTO memory_context_pack_evidence
              (pack_id,item_id,installation_id,evidence_id,evidence_version_id,excerpt_hash,source_version)
            SELECT $1,e.item_id,$2,e.evidence_id,e.version_id,decode(e.excerpt_hash,'hex'),e.source_version
            FROM jsonb_to_recordset($28::jsonb) e(item_id uuid,evidence_id uuid,version_id uuid,excerpt_hash text,source_version uuid)
            WHERE (SELECT count(*) FROM items)>=0
            ON CONFLICT DO NOTHING
            RETURNING (evidence_version_id IS NOT NULL AND excerpt_hash IS NOT NULL AND source_version IS NOT NULL) AS proven
          ), completed AS (
            UPDATE memory_generation_runs
            SET state='succeeded',output_kind='context_pack',output_id=$1,completed_at=NOW()
            WHERE run_id=$3 AND (SELECT count(*) FROM evidence_written)>=0
          )` : `, completed_empty AS (
            UPDATE memory_generation_runs
            SET state='succeeded',output_kind='context_pack',output_id=stored.pack_id,completed_at=NOW()
            FROM stored WHERE run_id=$3 AND $23='empty'
          )`}
          SELECT stable_tokens,dynamic_tokens
            ${lockedReferences ? ',(SELECT count(*)>0 AND bool_and(proven) FROM evidence_written) AS evidence_proven' : ''}
          FROM stored
        `, [packId, input.installationId, input.generationRunId, input.trajectoryId, input.sessionId,
          input.clientRequestId, input.agent, input.repositoryId, input.mode, input.effectivePolicyHash,
          input.settingsFingerprint, input.loadoutFingerprint, input.inputDigest, input.policyRevision, input.settingsRevision,
          input.loadoutRevision, stable, dynamic, hashPackText(stable),
          hashPackText(dynamic), estimateTokens(stable), estimateTokens(dynamic),
          input.state, input.errorCode ?? null, JSON.stringify(input.selectedReferences ?? []),
          JSON.stringify(input.queryContext??{repositoryId:input.repositoryId,repoSnapshotId:null,branch:null,taskScopeKey:null}),
          JSON.stringify(input.items.map((item, ordinal) => ({
            item_id:item.itemId, claim_id:item.claimId, version_id:item.versionId, claim_type:item.claimType,
            layer:item.layer, section:item.section, representation:item.representation, rendered_text:item.statement,
            reason_codes:item.reasonCodes, token_count:estimateTokens(item.statement), ordinal,
          }))),
          ...(lockedReferences ? [JSON.stringify(lockedReferences)] : [])])
        let evidenceProven = inserted.rowCount ? inserted.rows[0].evidence_proven ?? false : undefined
        let generationRecorded=Boolean(lockedReferences)||(input.state==='empty'&&Boolean(inserted.rowCount))
        if (evidence.length && !lockedReferences) {
          const references = await captureEvidenceReferences(client, input.installationId, evidence)
          const written = await client.query<{ proven: boolean }>(`
            WITH evidence_written AS (
              INSERT INTO memory_context_pack_evidence
                (pack_id, item_id, installation_id, evidence_id,evidence_version_id,excerpt_hash,source_hash,source_version)
              SELECT $1, e.item_id, $2, e.evidence_id, e.version_id, e.excerpt_hash, e.source_hash, e.source_version
              FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::bytea[], $7::text[], $8::uuid[])
                AS e(item_id, evidence_id, version_id, excerpt_hash, source_hash, source_version)
              ON CONFLICT DO NOTHING
              RETURNING (evidence_version_id IS NOT NULL AND excerpt_hash IS NOT NULL AND source_version IS NOT NULL) AS proven
            ), generation_written AS (
              UPDATE memory_generation_runs
              SET state='succeeded',output_kind='context_pack',output_id=$1::uuid,completed_at=NOW()
              FROM (SELECT count(*) AS written FROM evidence_written) proof
              WHERE run_id=$9::uuid AND proof.written>=0
            )
            SELECT proven FROM evidence_written
          `, [packId, input.installationId, evidence.map(ref => ref.itemId), evidence.map(ref => ref.evidenceId),
            references.map(ref => ref?.versionId ?? null), references.map(ref => ref?.excerptHash ?? null),
            references.map(ref => ref?.sourceHash ?? null), references.map(ref => ref?.sourceVersion ?? null), input.generationRunId])
          generationRecorded=true
          if (inserted.rowCount) evidenceProven = written.rows.length > 0 && written.rows.every(row => row.proven)
        }
        if (input.generationRunId&&!generationRecorded) {
          await client.query(`
            UPDATE memory_generation_runs
            SET state = 'succeeded', output_kind = 'context_pack', output_id = $2::uuid,
                completed_at = NOW()
            WHERE run_id = $1
          `, [input.generationRunId, packId])
        }
        mark('persist_insert')
        if(input.queryContext?.selectedScopeProof){
          const proof=input.queryContext.selectedScopeProof
          if(!await selectedScopeContextCurrent(client,proof))throw new ContextConsumptionChangedError()
          const origins=await selectedScopeOriginFences(client,proof)
          if(!await lockOriginPolicyFences(client,origins.fences,sourcePoolContext(pool).namespace))throw new ContextConsumptionChangedError()
          const valid=await client.query<{valid:boolean}>(`SELECT ${selectedScopeFenceSql('$1')} AND ${originPolicyFenceSql('$2',sourcePoolContext(pool).namespace)} AS valid`,[JSON.stringify(proof),JSON.stringify(origins.fences)])
          if(!origins.matches||!valid.rows[0]?.valid)throw new ContextConsumptionChangedError()
        }
        const originStamp=input.queryContext?.originPolicyStamp??null
        const checkDirectPack=Boolean(boundedTransaction&&inserted.rowCount&&lockedReferences
          && !(input.selectedReferences?.length)&&!input.queryContext?.selectedScopeProof&&originStamp===null)
        const stampGeneration=async (checkPack:boolean) => (await client.query<{
          generation:string|null;stamped:boolean;frame_current?:boolean;origin_absent?:boolean;machine_sources?:boolean
        }>(`
          WITH ${checkPack?`pack_checks AS MATERIALIZED (
            SELECT ${lifecycleFrameFenceSql('p','enabled','memory')} AS frame_current,
              NOT EXISTS (${originPolicyCorpusVersionsSql('p.installation_id')}) AS origin_absent,
              EXISTS (${DIRECT_MACHINE_PACK_VERSIONS_SQL}) AS machine_sources
            FROM memory_context_packs p
            WHERE p.installation_id=$1 AND p.pack_id=$2 AND p.selected_references='[]'::jsonb
          ), `:''}current_generation AS MATERIALIZED (
            SELECT g.generation FROM memory_scope_consumption_generations g
            ${checkPack?'JOIN pack_checks pc ON pc.frame_current AND pc.origin_absent AND NOT pc.machine_sources':''}
            WHERE g.installation_id=$1 FOR SHARE OF g
          ), stamped AS (
            UPDATE memory_context_packs p SET consumption_generation=g.generation
            FROM current_generation g
            WHERE p.pack_id=$2 AND ($3::text IS NULL OR g.generation::text=$3) RETURNING p.pack_id
          )
          SELECT g.generation::text,EXISTS(SELECT 1 FROM stamped) AS stamped${checkPack?',pc.*':''}
          FROM ${checkPack?'pack_checks pc LEFT JOIN current_generation g ON TRUE':'current_generation g'}
        `,[input.installationId,packId,input.consumptionGeneration??null])).rows[0]
        let needsMachineFence=true
        let directStamp:Awaited<ReturnType<typeof stampGeneration>>|undefined
        if(checkDirectPack){
          // Only packs without machine dependencies can lock the generation
          // here. Machine sources still acquire their native locks first.
          const current=await stampGeneration(true)
          if(!current?.frame_current||!current.origin_absent)throw new ContextConsumptionChangedError()
          needsMachineFence=current.machine_sources===true
          if(!needsMachineFence)directStamp=current
        }else{
          if(!await lifecycleFrameCurrent(client,input.installationId,input.queryContext?.lifecycle))throw new ContextConsumptionChangedError()
          const origin=await originPolicyCorpusSnapshot(client,input.installationId)
          if(origin.stamp!==originStamp)throw new ContextConsumptionChangedError()
        }
        if(inserted.rowCount&&prepared&&needsMachineFence){
          try{
            const machineVersions=await fenceMachinePackSources(client,input.installationId,packId,undefined,boundedTransaction)
            if(machineVersions.length)await client.query(`
              UPDATE memory_context_packs SET query_context=query_context||jsonb_build_object('machineSourceVersionIds',$2::jsonb)
              WHERE pack_id=$1`,[packId,JSON.stringify(machineVersions)])
          }catch(error){
            if(preparedSourceUnavailable(error)||['55P03','57014'].includes((error as {code?:string}).code??''))throw new ContextConsumptionChangedError()
            throw error
          }
        }
        // All source/FK dependencies precede the final generation fence.
        if(inserted.rowCount){
          const existing=directStamp??await stampGeneration(false)
          if(existing?.generation!=null&&!existing.stamped)throw new ContextConsumptionChangedError()
          if(existing?.generation==null){
            const generation=await fenceConsumptionGeneration(client,input.installationId,input.consumptionGeneration)
            await client.query('UPDATE memory_context_packs SET consumption_generation=$2 WHERE pack_id=$1',[packId,generation])
          }
        }else await fenceConsumptionGeneration(client,input.installationId,input.consumptionGeneration)
        const tokens = inserted.rows[0] ?? (await client.query<StoredTokens>(
          'SELECT stable_tokens, dynamic_tokens FROM memory_context_packs WHERE pack_id=$1', [packId],
        )).rows[0]
        mark('persist_fence')
        if(lockedEvidence){
          try{await lockedEvidence.assertForCommit(input.authorityGrant!)}catch(error){if(error instanceof TargetBindingError)throw new ContextConsumptionChangedError();throw error}
        }
        mark('persist_evidence_commit')
        commitDispatched = true
        await client.query('COMMIT')
        mark('persist_commit')
        return { packId, stableTokens: tokens?.stable_tokens ?? 0, dynamicTokens: tokens?.dynamic_tokens ?? 0, evidenceProven }
      } catch (error) {
        const rolledBack = await client.query('ROLLBACK').then(() => true, () => false)
        if (!commitDispatched && rolledBack && boundedTransaction && ['55P03', '57014'].includes((error as {code?:string}).code ?? '')) {
          throw new ContextConsumptionChangedError()
        }
        throw error
      } finally {
        client.release()
      }
    },

    async get(packId: string): Promise<{
      state: string
      mode: string
      stable_text: string
      dynamic_text: string
      stable_tokens: number
      dynamic_tokens: number
      item_count: number
      error_code: string | null
      degraded_components: string[] | null
    } | null> {
      const result = await pool.query(`
        SELECT p.state, p.mode, p.stable_text, p.dynamic_text,
               p.stable_tokens, p.dynamic_tokens, p.error_code,
               t.degraded_components,
               ((SELECT COUNT(*)::int FROM memory_context_pack_items i
                 WHERE i.pack_id = p.pack_id)
                + (SELECT COUNT(*)::int FROM jsonb_array_elements(p.selected_references) reference
                   WHERE reference->>'source_kind' = 'wiki_section' OR reference->>'installation_id' <> p.installation_id::text)) AS item_count
        FROM memory_context_packs p
        LEFT JOIN memory_retrieval_trajectories t ON t.trajectory_id = p.trajectory_id
        WHERE p.pack_id = $1
      `, [packId])
      return result.rows[0] ?? null
    },

    async listForSession(input: {
      installationId: string
      authorityGrant?: PackAuthorityGrant
      sessionId: string
      limit?: number
      beforeCreatedAt?: Date | string | null
      beforePackId?: string | null
    }): Promise<Array<{
      pack_id: string
      state: string
      client_request_id: string
      created_at: Date
      created_at_cursor: string
      mode: string
      agent: string
      stable_text: string
      dynamic_text: string
      stable_tokens: number
      dynamic_tokens: number
      error_code: string | null
      policy_revision: number
      settings_revision: number
      loadout_revision: number
      items: Array<{
        item_id: string
        claim_id: string
        version_id: string
        claim_type: string
        layer: string
        section: string
        representation: string
        reason_codes: string[]
        token_count: number
        ordinal: number
        evidence_ids: string[]
      }>
      trajectory: null | {
        result_state: string
        degraded_components: string[]
        candidates: Array<{
          version_id: string
          decision: string
          reason_code: string
          final_ordinal: number | null
        }>
      }
    }>> {
      const listed=await retainedSourceRead(pool,input,async db=>{
      const result = await db.query<{
        pack_id: string; state: string; client_request_id: string; created_at: Date; created_at_cursor: string
        mode: string; agent: string; stable_text: string; dynamic_text: string
        stable_tokens: number; dynamic_tokens: number; error_code: string | null
        policy_revision: string; settings_revision: string; loadout_revision: string
        trajectory_id: string | null; result_state: string | null; degraded_components: string[] | null; machine_source:boolean
      }>(`
        SELECT p.pack_id::text, p.state, p.client_request_id, p.created_at,
               to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
               p.mode, p.agent,
               CASE WHEN ${FOREIGN_PACK_SQL} THEN '' ELSE p.stable_text END AS stable_text,
               CASE WHEN ${FOREIGN_PACK_SQL} THEN '' ELSE p.dynamic_text END AS dynamic_text,
               p.stable_tokens, p.dynamic_tokens, p.error_code,
               p.policy_revision::text, p.settings_revision::text, p.loadout_revision::text,
               p.trajectory_id::text, t.result_state, t.degraded_components,
               EXISTS(${MACHINE_PACK_VERSIONS_SQL}) AS machine_source
        FROM memory_context_packs p
        LEFT JOIN memory_retrieval_trajectories t ON t.trajectory_id = p.trajectory_id
        WHERE p.installation_id = $1 AND p.session_id = $2
          AND ($3::timestamptz IS NULL OR (p.created_at, p.pack_id) < ($3, $4::uuid))
        ORDER BY p.created_at DESC, p.pack_id DESC
        LIMIT $5
      `, [input.installationId, input.sessionId,
        input.beforeCreatedAt ?? null, input.beforePackId ?? null,
        Math.min(Math.max(input.limit ?? 50, 1), 51)])
      const packIds = result.rows.map(row => row.pack_id)
      const withheld=new Set<string>()
      for(const pack of result.rows){
        if(pack.machine_source&&!await machinePackSourcesAvailable(db,input.installationId,pack.pack_id))withheld.add(pack.pack_id)
      }
      const items = packIds.length === 0 ? { rows: [] as Array<{
        pack_id: string; item_id: string; claim_id: string; version_id: string
        claim_type: string; layer: string; section: string; representation: string
        reason_codes: string[]; token_count: number; ordinal: number; evidence_ids: string[]
      }> } : await db.query<{
        pack_id: string; item_id: string; claim_id: string; version_id: string
        claim_type: string; layer: string; section: string; representation: string
        reason_codes: string[]; token_count: number; ordinal: number; evidence_ids: string[]
      }>(`
        SELECT i.pack_id::text, i.item_id::text, i.claim_id::text, i.version_id::text,
               i.claim_type, i.layer, i.section, i.representation, i.reason_codes,
               i.token_count, i.ordinal,
               ARRAY(SELECT pe.evidence_id::text FROM memory_context_pack_evidence pe
                     WHERE pe.pack_id = i.pack_id AND pe.item_id = i.item_id
                     ORDER BY pe.evidence_id) AS evidence_ids
        FROM memory_context_pack_items i
        WHERE i.pack_id = ANY($1::uuid[])
        ORDER BY i.pack_id, i.ordinal
      `, [packIds])
      const trajectoryIds = result.rows
        .map(row => row.trajectory_id)
        .filter((value): value is string => Boolean(value))
      const candidates = trajectoryIds.length === 0 ? { rows: [] as Array<{
        trajectory_id: string; version_id: string; decision: string
        reason_code: string; final_ordinal: number | null
      }> } : await db.query<{
        trajectory_id: string; version_id: string; decision: string
        reason_code: string; final_ordinal: number | null
      }>(`
        SELECT trajectory_id::text, version_id::text, decision, reason_code, final_ordinal
        FROM memory_retrieval_candidates
        WHERE trajectory_id = ANY($1::uuid[])
        ORDER BY trajectory_id, final_ordinal NULLS LAST, version_id
      `, [trajectoryIds])
      const itemsByPack = new Map<string, typeof items.rows>()
      for (const item of items.rows) {
        const group = itemsByPack.get(item.pack_id) ?? []
        group.push(item)
        itemsByPack.set(item.pack_id, group)
      }
      const candidatesByTrajectory = new Map<string, typeof candidates.rows>()
      for (const candidate of candidates.rows) {
        const group = candidatesByTrajectory.get(candidate.trajectory_id) ?? []
        group.push(candidate)
        candidatesByTrajectory.set(candidate.trajectory_id, group)
      }
      return result.rows.map(row => ({
        pack_id: row.pack_id,
        state: withheld.has(row.pack_id)?'invalidated':row.state,
        client_request_id: row.client_request_id,
        created_at: row.created_at,
        created_at_cursor: row.created_at_cursor,
        mode: row.mode,
        agent: row.agent,
        stable_text: withheld.has(row.pack_id)?'':row.stable_text,
        dynamic_text: withheld.has(row.pack_id)?'':row.dynamic_text,
        stable_tokens: Number(row.stable_tokens),
        dynamic_tokens: Number(row.dynamic_tokens),
        error_code: withheld.has(row.pack_id)?'source_invalidated':row.error_code,
        policy_revision: Number(row.policy_revision),
        settings_revision: Number(row.settings_revision),
        loadout_revision: Number(row.loadout_revision),
        items: (withheld.has(row.pack_id)?[]:itemsByPack.get(row.pack_id)??[]).map(({ pack_id: _packId, ...item }) => item),
        trajectory: !withheld.has(row.pack_id) && row.trajectory_id && row.result_state ? {
          result_state: row.result_state,
          degraded_components: row.degraded_components ?? [],
          candidates: (candidatesByTrajectory.get(row.trajectory_id) ?? [])
            .map(({ trajectory_id: _trajectoryId, ...candidate }) => candidate),
        } : null,
      }))
      })
      return listed??[]
    },

    /** Invalidate every not-yet-admitted dependent pack of a claim version. */
    async invalidateForVersions(input: {
      installationId: string
      versionIds: readonly string[]
    }): Promise<number> {
      const result = await pool.query(`
        UPDATE memory_context_packs p
        SET state = 'invalidated', invalidated_at = NOW(), error_code = 'source_invalidated'
        WHERE p.installation_id = $1
          AND p.state IN ('compiling','ready','shadow')
          AND EXISTS (
            SELECT 1 FROM memory_context_pack_items i
            WHERE i.pack_id = p.pack_id AND i.version_id = ANY($2::uuid[]))
          AND NOT EXISTS (
            SELECT 1 FROM memory_context_injections j
            WHERE j.pack_id = p.pack_id
              AND j.state IN ('admitted','prepared','delivered','delivery_failed'))
      `, [input.installationId, input.versionIds])
      return result.rowCount ?? 0
    },
  }

  return {
    ...repository,
    async persist(input: PersistPackInput, observe?: ObservePackPersistence): Promise<string> {
      return (await repository.persistWithSummary(input, observe)).packId
    },
  }
}

export type PackRepository = ReturnType<typeof createPackRepository>
