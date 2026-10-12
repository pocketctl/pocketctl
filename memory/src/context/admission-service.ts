import {revisionTimeSql} from '../claims/version-selection.js'
import {selectedScopeContextCurrent,selectedScopeFenceSql,selectedScopeOriginFences} from './selected-scope-dependencies.js'
import type {V2GrantFacts} from '../governance/authorization.js'
import {WIKI_SOURCE_TIME_INVALID_SQL} from './consumption.js'
import { createHash, createHmac, randomBytes, randomUUID } from 'crypto'
import type pg from 'pg'
import { createContextSettingsRepository, effectiveContextSettingsFingerprint } from './settings-repository.js'
import { createLoadoutRepository, resolvedLoadoutFingerprint } from './loadout-repository.js'
import { createPolicyRepository } from '../policies/repository.js'
import { createPolicyResolver } from '../policies/resolver.js'
import { resolveSelectedContextReferences, type SelectedContextReference } from './compiler.js'
import {originPolicyCorpusSnapshot,originPolicyFenceSql} from '../governance/origin-policy.js'
import {contextClaimFacts,eligibleContextFacts,fenceConsumptionGeneration,ContextConsumptionChangedError,type ContextQueryFrame} from './consumption.js'

/**
 * Admission is the linearization point for mode-off and revocation
 * (ADR-P2-05): ONE transaction rechecks settings, policy head, claim
 * activity, evidence liveness and tombstones immediately before native
 * delivery, then mints a single-use admission that expires in five seconds.
 * The nonce is returned once; only its HMAC is stored.
 */

export type AdmissionResult =
  | { ok: true; injectionId: string; nonce: string; expiresAt: Date }
  | { ok: true; existing: true; injectionId: string; state: string }
  | { ok: false; error: 'pack_not_ready' | 'mode_off' | 'claim_invalid' | 'expired' | 'pack_mismatch' }

export type ReceiptResult =
  | { ok: true; state: 'delivered' | 'delivery_failed' }
  | { ok: false; error: 'not_found' }

export type ConsumeResult =
  | { ok: true; pack: {
      packId: string
      stableText: string
      dynamicText: string
      stableHash: string
      dynamicHash: string
    } }
  | { ok: false; error: 'not_found' | 'expired' | 'already_consumed' }

export function createAdmissionService(deps: {
  pool: pg.Pool
  nonceHmacKey: Buffer
  admissionTtlSeconds?: number
}) {
  const ttl = deps.admissionTtlSeconds ?? 5

  return {
    async admit(input: {
      installationId: string
      sessionId: string
      clientRequestId: string
      packId: string
      agent: string
      adapter: string
      grantConfigVersion: string
      sharedGrantAuthorized?: boolean
      selectedScopeGrant?:V2GrantFacts
    }): Promise<AdmissionResult> {
      const client = await deps.pool.connect()
      try {
        await client.query('BEGIN')
        // Join compiler/Skill/cleanup's source-first order. Installation-first
        // admission can deadlock a Session purge that already owns its source.
        await client.query(`
          SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':' || $2, 0))
        `, [input.installationId, input.sessionId])
        await client.query(`
          SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:' || $1, 0))
        `, [input.installationId])

        const installation = await client.query<{
          relay_status: string
          local_status: string
          config_version: string
        }>(`
          SELECT relay_status, local_status, config_version::text
          FROM memory_installations
          WHERE installation_id = $1
          FOR SHARE
        `, [input.installationId])
        const installationRow = installation.rows[0]
        if (!installationRow
          || installationRow.relay_status !== 'active'
          || installationRow.local_status !== 'ready'
          || installationRow.config_version !== input.grantConfigVersion) {
          await client.query('COMMIT')
          return { ok: false, error: 'mode_off' }
        }

        // Idempotency: an existing admission for this client request returns
        // its state without compiling or admitting twice.
        const existing = await client.query<{ injection_id: string; state: string; expired: boolean }>(`
          SELECT injection_id::text, state,
                 COALESCE(admission_expires_at < NOW(), FALSE) AS expired
          FROM memory_context_injections
          WHERE installation_id = $1 AND session_id = $2 AND client_request_id = $3
          ORDER BY created_at DESC LIMIT 1
          FOR UPDATE
        `, [input.installationId, input.sessionId, input.clientRequestId])
        const prior = existing.rows[0]
        if (prior?.state === 'admitted' && prior.expired) {
          await client.query(`
            UPDATE memory_context_injections SET state = 'expired'
            WHERE injection_id = $1 AND state = 'admitted'
          `, [prior.injection_id])
          await client.query('COMMIT')
          return { ok: false, error: 'expired' }
        }
        if (prior && ['prepared', 'admitted', 'delivered', 'delivery_failed', 'skipped'].includes(prior.state)) {
          await client.query('COMMIT')
          return { ok: true, existing: true, injectionId: prior.injection_id, state: prior.state }
        }

        const pack = await client.query<{
          state: string
          agent: string
          mode: string
          repository_id: string | null
          effective_policy_hash: Buffer
          settings_fingerprint: Buffer | null
          loadout_fingerprint: Buffer | null
          loadout_revision: string
          selected_references: SelectedContextReference[]
          query_context:ContextQueryFrame|null;consumption_generation:string|null
        }>(`
          SELECT state, agent, mode, repository_id::text, effective_policy_hash,
                 settings_fingerprint, loadout_fingerprint, loadout_revision::text,
                 selected_references,query_context,consumption_generation::text
          FROM memory_context_packs
          WHERE pack_id = $1 AND installation_id = $2 AND session_id = $3
            AND client_request_id = $4
          FOR UPDATE
        `, [input.packId, input.installationId, input.sessionId, input.clientRequestId])
        const packRow = pack.rows[0]
        if (!packRow || packRow.state !== 'ready') {
          await client.query('COMMIT')
          return { ok: false, error: 'pack_not_ready' }
        }
        const queryContext=packRow.query_context??{repositoryId:packRow.repository_id,repoSnapshotId:null,branch:null,taskScopeKey:null}
        const selectedReferences = Array.isArray(packRow.selected_references)
          ? packRow.selected_references : []
        const sharedItems = await client.query<{ n: number }>(`
          SELECT COUNT(*)::int AS n
          FROM memory_context_pack_items i
          JOIN knowledge_claims c
            ON c.installation_id = i.installation_id AND c.claim_id = i.claim_id
          WHERE i.pack_id = $1 AND i.installation_id = $2
            AND c.owner_scope_kind <> 'personal'
        `, [input.packId, input.installationId])
        if (Number(sharedItems.rows[0]?.n ?? 0) > 0 && selectedReferences.length === 0) {
          await client.query('COMMIT')
          return { ok: false, error: 'mode_off' }
        }
        if (selectedReferences.some(reference=>reference.source_kind==='wiki_section'||reference.installation_id!==input.installationId)
          && (packRow.consumption_generation===null||packRow.query_context===null)) {
          await client.query("UPDATE memory_context_packs SET state='invalidated',invalidated_at=NOW(),error_code='consumption_context_changed' WHERE pack_id=$1",[input.packId])
          await client.query('COMMIT')
          return {ok:false,error:'claim_invalid'}
        }
        if (selectedReferences.length > 0) {
          const proof=queryContext.selectedScopeProof
          const selectedValid=proof
            ? !!input.selectedScopeGrant && await selectedScopeContextCurrent(client,proof,input.selectedScopeGrant)
            : input.sharedGrantAuthorized && await resolveSelectedContextReferences(transactionPoolFromClient(client),input.installationId,selectedReferences,queryContext)
          if (!selectedValid) {
            await client.query('COMMIT')
            return { ok: false, error: 'claim_invalid' }
          }
        }

        const adapterForAgent: Record<string, string> = {
          codex: 'codex-app-server',
          opencode: 'opencode-server',
          'claude-code': 'claude-print-resume',
        }
        if (packRow.agent !== input.agent || packRow.mode !== 'enabled'
          || adapterForAgent[input.agent] !== input.adapter) {
          await client.query('COMMIT')
          return { ok: false, error: 'pack_mismatch' }
        }

        // Resolve the same policy/settings/loadout inputs used by compilation,
        // but on this transaction's connection. Any changed head, scope row or
        // loadout makes the immutable ready pack stale.
        const transactionPool = { query: client.query.bind(client) } as unknown as pg.Pool
        const currentSettings = await createContextSettingsRepository(transactionPool).resolve({
          installationId: input.installationId,
          repositoryId: packRow.repository_id,
          sessionId: input.sessionId,
          agent: input.agent,
        })
        if (currentSettings.mode !== 'enabled') {
          await client.query('COMMIT')
          return { ok: false, error: 'mode_off' }
        }
        if (!packRow.settings_fingerprint
          || !packRow.settings_fingerprint.equals(effectiveContextSettingsFingerprint(currentSettings))) {
          await client.query('COMMIT')
          return { ok: false, error: 'pack_mismatch' }
        }
        const policyRepository = createPolicyRepository(transactionPool)
        const policyResolver = createPolicyResolver({
          pool: transactionPool,
          repository: policyRepository,
        })
        const currentPolicy = await policyResolver.resolve({
          installationId: input.installationId, kind: 'context', repositoryId: packRow.repository_id,
        })
        const currentRankingPolicy = await policyResolver.resolve({
          installationId: input.installationId, kind: 'ranking', repositoryId: packRow.repository_id,
        })
        const currentPolicyHash = createHash('sha256')
          .update(currentPolicy.effectivePolicyHash)
          .update(currentRankingPolicy.effectivePolicyHash)
          .digest()
        if (!packRow.effective_policy_hash.equals(currentPolicyHash)) {
          await client.query('COMMIT')
          return { ok: false, error: 'pack_mismatch' }
        }
        const currentLoadout = await createLoadoutRepository(transactionPool).resolve({
          installationId: input.installationId,
          repositoryId: packRow.repository_id,
          agent: input.agent,
        })
        if (Number(packRow.loadout_revision) !== currentLoadout.revision
          || !packRow.loadout_fingerprint
          || !packRow.loadout_fingerprint.equals(resolvedLoadoutFingerprint(currentLoadout))) {
          await client.query('COMMIT')
          return { ok: false, error: 'pack_mismatch' }
        }

        // Claim/evidence liveness recheck over the pack's dependency join.
        const invalid = await client.query<{ n: number }>(`
          SELECT COUNT(*)::int AS n FROM memory_context_pack_items i
          JOIN knowledge_claims c ON c.claim_id = i.claim_id AND c.installation_id = i.installation_id
          WHERE i.pack_id = $1 AND i.installation_id = $2
            AND (c.state <> 'active' OR c.current_version_id IS NULL
                 OR c.current_version_id <> i.version_id
                 OR NOT EXISTS (
                   SELECT 1 FROM knowledge_evidence e
                   WHERE e.installation_id = i.installation_id
                     AND e.version_id = i.version_id))
        `, [input.packId, input.installationId])
        if ((invalid.rows[0]?.n ?? 0) > 0) {
          await client.query('COMMIT')
          return { ok: false, error: 'claim_invalid' }
        }

        // Tombstone recheck for the target and every Evidence source Session.
        const tombstoned = await client.query<{ n: number }>(`
          SELECT COUNT(*)::int AS n
          FROM memory_session_tombstones t
          WHERE t.installation_id = $1
            AND (t.session_id = $2 OR EXISTS (
              SELECT 1
              FROM memory_context_pack_evidence pe
              JOIN knowledge_evidence e
                ON e.installation_id = pe.installation_id AND e.evidence_id = pe.evidence_id
              JOIN work_episodes w
                ON w.installation_id = e.installation_id AND w.episode_id = e.episode_id
              WHERE pe.pack_id = $3 AND w.session_id = t.session_id))
        `, [input.installationId, input.sessionId, input.packId])
        if ((tombstoned.rows[0]?.n ?? 0) > 0) {
          await client.query('COMMIT')
          return { ok: false, error: 'claim_invalid' }
        }
        const dependencies=(await client.query<{version_id:string}>('SELECT DISTINCT version_id::text FROM memory_context_pack_items WHERE pack_id=$1 AND installation_id=$2',[input.packId,input.installationId])).rows
        const facts=await contextClaimFacts(client,input.installationId,dependencies.map(row=>row.version_id),true)
        let sourceInvalid=dependencies.some(row=>{const source=facts.get(row.version_id);return !source||!eligibleContextFacts(source,queryContext)
          ||(packRow.consumption_generation===null&&source.applicability!=null)})
        const origin=await originPolicyCorpusSnapshot(client,input.installationId)
        if(origin.stamp!==(queryContext.originPolicyStamp??null))sourceInvalid=true
        let admittedGeneration:string|undefined
        try{admittedGeneration=await fenceConsumptionGeneration(client,input.installationId,packRow.consumption_generation??undefined)}
        catch(error){if(!(error instanceof ContextConsumptionChangedError))throw error;sourceInvalid=true}
        if(sourceInvalid){
          await client.query("UPDATE memory_context_packs SET state='invalidated',invalidated_at=NOW(),error_code='consumption_context_changed' WHERE pack_id=$1",[input.packId])
          await client.query('COMMIT');return{ok:false,error:'claim_invalid'}
        }

        if (prior && prior.state === 'expired') {
          await client.query('COMMIT')
          return { ok: false, error: 'expired' }
        }

        const nonce = randomBytes(24).toString('hex')
        const nonceHmac = createHmac('sha256', deps.nonceHmacKey).update(nonce).digest()
        const injectionId = randomUUID()
        const inserted = await client.query<{ admission_expires_at: Date }>(`
          INSERT INTO memory_context_injections
            (injection_id, installation_id, pack_id, session_id, client_request_id,
             agent, adapter, admission_nonce_hmac, state, admitted_at, admission_expires_at,consumption_generation)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'admitted', clock_timestamp(),
                  clock_timestamp() + ($9 * INTERVAL '1 second'),$10)
          RETURNING admission_expires_at
        `, [injectionId, input.installationId, input.packId, input.sessionId,
          input.clientRequestId, input.agent, input.adapter, nonceHmac, ttl,admittedGeneration])
        if(queryContext.selectedScopeProof){
          const proof=queryContext.selectedScopeProof,origins=await selectedScopeOriginFences(client,proof)
          const valid=await client.query<{valid:boolean}>(`SELECT ${selectedScopeFenceSql('$1')} AND ${originPolicyFenceSql('$2')} AND ($3::double precision IS NULL OR clock_timestamp()<to_timestamp($3::double precision)) AS valid`,[JSON.stringify(proof),JSON.stringify(origins.fences),input.selectedScopeGrant?.expiresAt??null])
          if(!origins.matches||!valid.rows[0]?.valid){await client.query('ROLLBACK');return{ok:false,error:'claim_invalid'}}
        }
        await client.query('COMMIT')
        return { ok: true, injectionId, nonce, expiresAt: inserted.rows[0].admission_expires_at }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },

    /** Single-use consumption: expired admissions can never deliver. */
    async assertUsable(input: { injectionId: string }): Promise<boolean> {
      const result = await deps.pool.query(`
        UPDATE memory_context_injections
        SET state = CASE WHEN admission_expires_at < NOW() THEN 'expired' ELSE state END
        WHERE injection_id = $1 AND state = 'admitted'
        RETURNING (state = 'admitted' AND admission_expires_at >= NOW()) AS usable
      `, [input.injectionId])
      return Boolean(result.rows[0]?.usable)
    },

    /**
     * Consume the five-second admission exactly once and return the immutable
     * pack bytes in the same atomic statement. The clear nonce is compared by
     * HMAC and never persisted or logged.
     */
    async consume(input: {
      installationId: string
      sessionId: string
      packId: string
      injectionId: string
      nonce: string
      selectedScopeGrant?:V2GrantFacts
    }): Promise<ConsumeResult> {
      const client=await deps.pool.connect()
      try {
        await client.query('BEGIN')
        // Lock only the authenticated owned injection. Source reads and their
        // SQL fences use fresh READ COMMITTED snapshots after any lock wait.
        const result:ConsumeResult=await (async()=>{
          const nonceHmac = createHmac('sha256', deps.nonceHmacKey).update(input.nonce).digest()
          const frozen=(await client.query<{query_context:ContextQueryFrame|null}>(`SELECT p.query_context FROM memory_context_injections j
            JOIN memory_context_packs p ON p.pack_id=j.pack_id AND p.installation_id=j.installation_id
            WHERE j.injection_id=$1 AND j.installation_id=$2 AND j.session_id=$3 AND j.pack_id=$4 AND j.admission_nonce_hmac=$5 AND j.state='admitted' FOR UPDATE OF j`,
            [input.injectionId,input.installationId,input.sessionId,input.packId,nonceHmac])).rows[0]
          const origin=frozen?await originPolicyCorpusSnapshot(client,input.installationId):{stamp:null,fences:[]}
          const proof=frozen?.query_context?.selectedScopeProof
          const selected=proof?await selectedScopeOriginFences(client,proof):{matches:true,fences:[]}
          const selectionMatches=!proof||(!!input.selectedScopeGrant&&await selectedScopeContextCurrent(client,proof,input.selectedScopeGrant))
          const currentGrantDeadline=proof?input.selectedScopeGrant?.expiresAt??null:null
          const currentGrantClockSql="($9::double precision IS NULL OR clock_timestamp()<to_timestamp($9::double precision))"
          const originMatches=(!frozen||origin.stamp===(frozen.query_context?.originPolicyStamp??null))&&selected.matches&&selectionMatches
          const originFences=JSON.stringify([...origin.fences,...selected.fences])
          const selectionProof=JSON.stringify(proof??null)
          const consumed = await client.query<{
            pack_id: string
            stable_text: string
            dynamic_text: string
            stable_hash: Buffer | null
            dynamic_hash: Buffer | null
          }>(`
            UPDATE memory_context_injections j
            SET state = 'prepared'
            FROM memory_context_packs p
            WHERE j.injection_id = $1 AND j.installation_id = $2
              AND j.session_id = $3 AND j.pack_id = $4
              AND j.state = 'admitted' AND j.admission_expires_at >= clock_timestamp()
              AND j.admission_nonce_hmac = $5
              AND p.pack_id = j.pack_id AND p.installation_id = j.installation_id
              AND $6::boolean AND ${originPolicyFenceSql('$7')} AND ${selectedScopeFenceSql('$8')} AND ${currentGrantClockSql}
              AND p.state = 'ready' AND NOT (${WIKI_SOURCE_TIME_INVALID_SQL})
              AND j.consumption_generation=COALESCE((SELECT generation FROM memory_scope_consumption_generations WHERE installation_id=p.installation_id),1)
              AND NOT EXISTS(SELECT 1 FROM memory_context_pack_items item JOIN knowledge_versions version ON version.installation_id=item.installation_id AND version.version_id=item.version_id
                WHERE item.pack_id=p.pack_id AND (NOT ${revisionTimeSql('version')} OR (version.valid_from IS NOT NULL AND version.valid_from>clock_timestamp()) OR (version.valid_until IS NOT NULL AND version.valid_until<=clock_timestamp())))
            RETURNING p.pack_id::text, p.stable_text, p.dynamic_text,
                      p.stable_hash, p.dynamic_hash
          `, [input.injectionId, input.installationId, input.sessionId, input.packId, nonceHmac,originMatches,originFences,selectionProof,currentGrantDeadline])
          const row = consumed.rows[0]
          if (row) {
            return {
              ok: true,
              pack: {
                packId: row.pack_id,
                stableText: row.stable_text,
                dynamicText: row.dynamic_text,
                stableHash: row.stable_hash?.toString('hex') ?? '',
                dynamicHash: row.dynamic_hash?.toString('hex') ?? '',
              },
            }
          }
          const state = await client.query<{ state: string; expired: boolean }>(`
            UPDATE memory_context_injections j
            SET state = CASE WHEN j.state = 'admitted' AND (NOT $6::boolean OR NOT (${currentGrantClockSql}) OR NOT (${originPolicyFenceSql('$7')}) OR NOT (${selectedScopeFenceSql('$8')}) OR ${WIKI_SOURCE_TIME_INVALID_SQL} OR j.admission_expires_at < clock_timestamp() OR p.state<>'ready'
              OR j.consumption_generation IS NULL OR j.consumption_generation<>COALESCE((SELECT generation FROM memory_scope_consumption_generations WHERE installation_id=p.installation_id),1)
              OR EXISTS(SELECT 1 FROM memory_context_pack_items item JOIN knowledge_versions version ON version.installation_id=item.installation_id AND version.version_id=item.version_id
                WHERE item.pack_id=p.pack_id AND (NOT ${revisionTimeSql('version')} OR (version.valid_from IS NOT NULL AND version.valid_from>clock_timestamp()) OR (version.valid_until IS NOT NULL AND version.valid_until<=clock_timestamp()))))
              THEN 'expired' ELSE j.state END,
              outcome_code=CASE WHEN j.state='admitted' AND j.admission_expires_at>=clock_timestamp() THEN 'consumption_context_changed' ELSE j.outcome_code END
            FROM memory_context_packs p
            WHERE j.injection_id = $1 AND j.installation_id = $2 AND j.session_id = $3 AND j.pack_id = $4
              AND j.admission_nonce_hmac=$5 AND p.pack_id=j.pack_id AND p.installation_id=j.installation_id
            RETURNING j.state, j.admission_expires_at < clock_timestamp() AS expired
          `, [input.injectionId, input.installationId, input.sessionId, input.packId,nonceHmac,originMatches,originFences,selectionProof,currentGrantDeadline])
          if (!state.rows[0]) return { ok: false, error: 'not_found' }
          if (state.rows[0].expired || state.rows[0].state === 'expired') {
            return { ok: false, error: 'expired' }
          }
          return { ok: false, error: 'already_consumed' }
        })()
        await client.query('COMMIT')
        return result
      }catch(error){
        await client.query('ROLLBACK').catch(()=>undefined)
        throw error
      }finally{client.release()}

    },

    /** Idempotent delivery receipt; never triggers a user-turn resend. */
    async receipt(input: {
      injectionId: string
      installationId: string
      sessionId: string
      delivered: boolean
      outcomeCode?: string
    }): Promise<ReceiptResult> {
      const result = await deps.pool.query<{ state: string }>(`
        UPDATE memory_context_injections
		SET state = CASE WHEN state IN ('delivered', 'delivery_failed') THEN state
                         WHEN $3 THEN 'delivered' ELSE 'delivery_failed' END,
            delivered_at = CASE WHEN $3 AND delivered_at IS NULL THEN NOW() ELSE delivered_at END,
			outcome_code = CASE WHEN state = 'prepared' THEN COALESCE($4, outcome_code)
			                    ELSE outcome_code END
        WHERE injection_id = $1 AND installation_id = $2 AND session_id = $5
		  AND state IN ('prepared', 'delivered', 'delivery_failed')
        RETURNING state
      `, [input.injectionId, input.installationId, input.delivered, input.outcomeCode ?? null, input.sessionId])
      const row = result.rows[0] as { state: 'delivered' | 'delivery_failed' } | undefined
      if (!row) {
		return { ok: false, error: 'not_found' }
      }
      return { ok: true, state: row.state }
    },
  }
}

function transactionPoolFromClient(client: pg.PoolClient): pg.Pool {
  return { query: client.query.bind(client) } as unknown as pg.Pool
}

export type AdmissionService = ReturnType<typeof createAdmissionService>
