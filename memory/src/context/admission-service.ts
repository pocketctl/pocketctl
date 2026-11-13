import {DIRECT_MACHINE_PACK_VERSIONS_SQL,MACHINE_PACK_VERSIONS_SQL,fenceMachinePackSources,machinePackSourcesAvailable,type PackAuthorityGrant} from './pack-repository.js'
import {MemoryApiError} from '../api/errors.js'
import {preparedSourceUnavailable} from '../sources/prepared-sources.js'
import {isPhysicalSourcePool,sourcePoolContext} from '../sources/pool-context.js'
import {currentPersonalInstallation,lockCurrentRelayAuthority,personalLifecycleAuthorityStampSql,personalLifecycleAuthorityStateSql,personalLifecycleDeliveryStampSql} from '../sources/current-grant.js'
import type {CurationMode} from '../curation/contracts.js'
import {lifecycleFrameCurrent,lifecycleFrameFenceSql} from './lifecycle-frame.js'
import {revisionTimeSql} from '../claims/version-selection.js'
import { deliveryVersionAvailableSql } from '../episodes/delivery-withdrawal.js'
import {selectedScopeContextCurrent,selectedScopeFenceSql,selectedScopeOriginFences} from './selected-scope-dependencies.js'
import {TargetBindingError,type V2GrantFacts} from '../governance/authorization.js'
import {WIKI_SOURCE_TIME_INVALID_SQL} from './consumption.js'
import { createHash, createHmac, randomBytes, randomUUID } from 'crypto'
import type pg from 'pg'
import { resolveContextSettings, effectiveContextSettingsFingerprint } from './settings-repository.js'
import { loadoutItemsSql, resolveLoadoutItems, resolvedLoadoutFingerprint } from './loadout-repository.js'
import { createPolicyRepository } from '../policies/repository.js'
import { createPolicyResolver } from '../policies/resolver.js'
import { resolveSelectedContextReferences, type SelectedContextReference } from './compiler.js'
import {originPolicyCorpusSnapshot,originPolicyCorpusVersionsSql,originPolicyFenceSql,lockOriginPolicyFences} from '../governance/origin-policy.js'
import {createTransactionBoundPool} from '../api/transaction-bound-pool.js'
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

type PersonalGrant = Exclude<PackAuthorityGrant, V2GrantFacts>
type NativeInstallationState = NonNullable<Parameters<typeof currentPersonalInstallation>[0]> & {
  authorization_epoch: string
  owner_scope_id: string
}
const nativeInstallationStateSql = (id: string) =>
  `(SELECT state FROM shared.memory_current_grant_states(ARRAY[${id}::uuid],ARRAY[]::uuid[]) LIMIT 1)`

function matchesPersonalGrant(state: NativeInstallationState | null | undefined, grant: PersonalGrant): boolean {
  const current = currentPersonalInstallation(state)
  return current.current && current.configVersion === grant.configVersion
    && (grant.userId === undefined || current.ownerUserId === String(grant.userId))
}

export function createAdmissionService(deps: {
  pool: pg.Pool
  lifecycleMode?:CurationMode
  nonceHmacKey: Buffer
  admissionTtlSeconds?: number
}) {
  const ttl = deps.admissionTtlSeconds ?? 5
  const physical = isPhysicalSourcePool(deps.pool)
  const timeouts = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'"
  const begin = async (client: pg.PoolClient, bounded: boolean, withoutJit = false) => {
    if (bounded && physical) {
      await client.query(`BEGIN; ${timeouts}${withoutJit ? '; SET LOCAL jit=off' : ''}`)
    } else {
      await client.query('BEGIN')
      if (bounded) await client.query(timeouts)
    }
  }

  // The native lock reports busy and missing alike. On this failure path
  // only, classify a definitively stale signed grant without waiting.
  const rejectStalePersonalGrant = async (client:pg.PoolClient,grant:PersonalGrant) => {
    const {rows}=await client.query<{local_status:string;authority:NativeInstallationState|null}>(`
      SELECT local_status,${nativeInstallationStateSql('$1')} AS authority
      FROM memory_installations WHERE installation_id=$1
    `,[grant.installationId])
    const row=rows[0]
    if(!row||!matchesPersonalGrant(row.authority,grant)
      ||['purging','purged','integrity_error'].includes(row.local_status)){
      throw new MemoryApiError('unauthorized','grant rejected')
    }
  }

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
      authorityGrant?:PackAuthorityGrant
      verifyInstallation?:boolean
    }): Promise<AdmissionResult> {
      const grant = input.authorityGrant
      const nativeGrant = sourcePoolContext(deps.pool).namespace === 'memory'
        && grant && !('scopeBindings' in grant) ? grant : undefined
      if (nativeGrant && (nativeGrant.installationId !== input.installationId
        || nativeGrant.configVersion !== input.grantConfigVersion)) {
        return { ok: false, error: 'mode_off' }
      }
      const client = await deps.pool.connect()
      try {
        await begin(client,Boolean(nativeGrant))
        // Join compiler/Skill/cleanup's source-first order. Installation-first
        // admission can deadlock a Session purge that already owns its source.
        const locks = await client.query<{ locked: boolean }>(`
          WITH authority AS MATERIALIZED (
            SELECT ${nativeGrant?"shared.lock_memory_grant_authority(ARRAY[$1::text::uuid],ARRAY[]::uuid[])":'TRUE'} AS locked
          ), session_lock AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':' || $2, 0))
            FROM authority WHERE locked
          )
          SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:' || $1, 0)) IS NOT NULL AS locked
          FROM session_lock
        `, [input.installationId, input.sessionId])
        if (!locks.rows[0]?.locked) {
          if(input.verifyInstallation&&nativeGrant)await rejectStalePersonalGrant(client,nativeGrant)
          await client.query('ROLLBACK')
          return { ok: false, error: 'claim_invalid' }
        }

        // The native authority and purge locks already hold. Preserve the
        // installation -> prior nonce -> pack lock order in this snapshot.
        const observed = (await client.query<{
          local_status:string
          grant_current:boolean
          prior:{injection_id:string;state:string;expired:boolean}|null
          state: string | null
          agent: string
          mode: string
          repository_id: string | null
          effective_policy_hash: Buffer
          settings_fingerprint: Buffer | null
          loadout_fingerprint: Buffer | null
          loadout_revision: string
          selected_references: SelectedContextReference[]
          query_context:ContextQueryFrame|null;consumption_generation:string|null
          has_shared_items: boolean
        }>(`
          WITH installation AS MATERIALIZED (
            SELECT installation_id,relay_status,local_status,config_version::text
            FROM memory_installations WHERE installation_id=$1 FOR SHARE
          ), authority AS MATERIALIZED (
            SELECT installation.*,
              ${nativeGrant?nativeInstallationStateSql('$1'):'NULL::jsonb'} AS native
            FROM installation
          ), checked AS MATERIALIZED (
            SELECT authority.*,(
              ${nativeGrant?`native @> '{"owner_scope_kind":"personal","owner_exists":true,"provider_enabled":true,"status":"active"}'
                AND native->>'config_version'=$4 AND ($7::text IS NULL OR native->>'owner_user_id'=$7)`
                :"relay_status='active' AND config_version=$4 AND $7::text IS NULL"}
              AND ($6::double precision IS NULL OR clock_timestamp()<to_timestamp($6::double precision))
            ) AS grant_current FROM authority
          ), prior AS MATERIALIZED (
            SELECT j.injection_id::text,j.state,COALESCE(j.admission_expires_at<NOW(),FALSE) AS expired
            FROM checked i JOIN memory_context_injections j USING(installation_id)
            WHERE i.local_status='ready' AND i.grant_current AND j.session_id=$2 AND j.client_request_id=$3
            ORDER BY j.created_at DESC LIMIT 1 FOR UPDATE OF j
          ), locked_pack AS MATERIALIZED (
            SELECT p.state,p.agent,p.mode,p.repository_id::text,p.effective_policy_hash,
              p.settings_fingerprint,p.loadout_fingerprint,p.loadout_revision::text,
              p.selected_references,p.query_context,p.consumption_generation::text
            FROM checked i JOIN memory_context_packs p USING(installation_id)
            WHERE i.local_status='ready' AND i.grant_current AND p.pack_id=$5
              AND p.session_id=$2 AND p.client_request_id=$3
              AND NOT EXISTS(SELECT 1 FROM prior WHERE state IN ('admitted','prepared','delivered','delivery_failed','skipped'))
            FOR UPDATE OF p
          )
          SELECT i.local_status,
            i.grant_current AND ($6::double precision IS NULL OR clock_timestamp()<to_timestamp($6::double precision)) AS grant_current,
            (SELECT to_jsonb(prior) FROM prior) AS prior, p.*,
            CASE WHEN p.state = 'ready' THEN EXISTS (
            SELECT 1 FROM memory_context_pack_items i
            JOIN knowledge_claims c USING (installation_id, claim_id)
            WHERE i.pack_id = $5 AND i.installation_id = $1
              AND c.owner_scope_kind <> 'personal'
          ) ELSE FALSE END AS has_shared_items
          FROM checked i LEFT JOIN locked_pack p ON TRUE
        `,[input.installationId,input.sessionId,input.clientRequestId,input.grantConfigVersion,input.packId,
          nativeGrant?.expiresAt??null,nativeGrant?.userId?.toString()??null])).rows[0]
        if(input.verifyInstallation&&(!observed||!observed.grant_current
          ||['purging','purged','integrity_error'].includes(observed.local_status))){
          throw new MemoryApiError('unauthorized','grant rejected')
        }
        if(!observed||observed.local_status!=='ready'||!observed.grant_current){
          await client.query('COMMIT')
          return {ok:false,error:'mode_off'}
        }

        // A previously admitted request keeps the original nonce history.
        const prior = observed.prior
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

        const packRow=observed
        if(packRow.state!=='ready'){
          await client.query('COMMIT')
          return {ok:false,error:'pack_not_ready'}
        }
        const queryContext=packRow.query_context??{repositoryId:packRow.repository_id,repoSnapshotId:null,branch:null,taskScopeKey:null}
        const selectedReferences = Array.isArray(packRow.selected_references)
          ? packRow.selected_references : []
        if (packRow.has_shared_items && selectedReferences.length === 0) {
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
        const transactionPool = createTransactionBoundPool(client)
        const configuration = (await client.query<{
          settings: Array<Omit<Parameters<typeof resolveContextSettings>[1][number],'revision'>&{revision:string}>
          loadout: {revision:string;items:Parameters<typeof resolveLoadoutItems>[0]}|null
        }>(`
          WITH loadout AS MATERIALIZED (
            SELECT loadout_id,revision::text FROM memory_context_loadouts
            WHERE installation_id=$1 AND repository_id IS NOT DISTINCT FROM $2::uuid
              AND agent IS NOT DISTINCT FROM $4
          )
          SELECT COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'scopeKind',s.scope_kind,'scopeKey',s.scope_key,'agent',s.agent,
              'mode',s.mode,'maxTokens',s.max_tokens,'revision',s.revision::text))
            FROM memory_context_settings s WHERE s.installation_id=$1
              AND (s.agent IS NULL OR s.agent=$4)
              AND ((s.scope_kind='installation' AND s.scope_key='global')
                OR (s.scope_kind='repository' AND s.scope_key=$2::uuid::text)
                OR (s.scope_kind='session' AND s.scope_key=$3))
          ),'[]'::jsonb) AS settings, (
            SELECT jsonb_build_object('revision',l.revision,'items',COALESCE((
              SELECT jsonb_agg(item ORDER BY item.priority DESC,item.item_id ASC) FROM (
                ${loadoutItemsSql('l.loadout_id')}
              ) item
            ),'[]'::jsonb)) FROM loadout l
          ) AS loadout
        `,[input.installationId,packRow.repository_id,input.sessionId,input.agent])).rows[0]
        const currentSettings = resolveContextSettings({
          installationId: input.installationId,
          repositoryId: packRow.repository_id,
          sessionId: input.sessionId,
          agent: input.agent,
        },configuration.settings.map(setting=>({...setting,revision:Number(setting.revision)})))
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
        const [currentPolicy, currentRankingPolicy] = await policyResolver.resolveContext({
          installationId: input.installationId, repositoryId: packRow.repository_id,
        })
        const currentPolicyHash = createHash('sha256')
          .update(currentPolicy.effectivePolicyHash)
          .update(currentRankingPolicy.effectivePolicyHash)
          .digest()
        if (!packRow.effective_policy_hash.equals(currentPolicyHash)) {
          await client.query('COMMIT')
          return { ok: false, error: 'pack_mismatch' }
        }
        const currentLoadout = configuration.loadout
          ? {revision:Number(configuration.loadout.revision),items:resolveLoadoutItems(configuration.loadout.items)}
          : {revision:1,items:[]}
        if (Number(packRow.loadout_revision) !== currentLoadout.revision
          || !packRow.loadout_fingerprint
          || !packRow.loadout_fingerprint.equals(resolvedLoadoutFingerprint(currentLoadout))) {
          await client.query('COMMIT')
          return { ok: false, error: 'pack_mismatch' }
        }

        // Observe liveness, Session tombstones and dependency membership in
        // one snapshot. The exact claim rows are still locked and rechecked below.
        const validity = (await client.query<{invalid:boolean; tombstoned:boolean; versions:string[]}>(`
          WITH items AS MATERIALIZED (
            SELECT claim_id, version_id
            FROM memory_context_pack_items WHERE pack_id=$1 AND installation_id=$2
          )
          SELECT EXISTS(
            SELECT 1 FROM items i JOIN knowledge_claims c ON c.installation_id=$2 AND c.claim_id=i.claim_id
            WHERE c.state<>'active' OR c.current_version_id IS DISTINCT FROM i.version_id
              OR NOT EXISTS(SELECT 1 FROM knowledge_evidence e WHERE e.installation_id=$2 AND e.version_id=i.version_id)
          ) AS invalid, EXISTS(
            SELECT 1 FROM memory_session_tombstones t WHERE t.installation_id=$2
            AND (t.session_id=$3 OR EXISTS(
              SELECT 1 FROM memory_context_pack_evidence pe
              JOIN knowledge_evidence e USING(installation_id,evidence_id)
              JOIN work_episodes w ON w.installation_id=e.installation_id AND w.episode_id=e.episode_id
              WHERE pe.pack_id=$1 AND w.session_id=t.session_id))
          ) AS tombstoned, ARRAY(SELECT DISTINCT version_id::text FROM items) AS versions
        `,[input.packId,input.installationId,input.sessionId])).rows[0]
        if(validity.invalid||validity.tombstoned){
          await client.query('COMMIT')
          return { ok: false, error: 'claim_invalid' }
        }
        const dependencies=validity.versions
        const facts=await contextClaimFacts(client,input.installationId,dependencies,{lock:true})
        // FOR SHARE returns the current Claim tuple after a concurrent
        // owner change. An earlier unlocked snapshot can see the old owner.
        if(selectedReferences.length===0&&[...facts.values()].some(source=>source.ownerScopeKind!=='personal')){
          await client.query('COMMIT')
          return {ok:false,error:'mode_off'}
        }
        let sourceInvalid=dependencies.some(versionId=>{const source=facts.get(versionId);return !source||!eligibleContextFacts(source,queryContext)
          ||(packRow.consumption_generation===null&&source.applicability!=null)})
        const originStamp=queryContext.originPolicyStamp??null
        const lifecycleMode=deps.lifecycleMode??'off'
        const directPack=physical&&nativeGrant&&!selectedReferences.length
          && !queryContext.selectedScopeProof&&originStamp===null?{packId:input.packId,lifecycleMode}:undefined
        if(!directPack){
          if(!await lifecycleFrameCurrent(client,input.installationId,queryContext.lifecycle,lifecycleMode))sourceInvalid=true
          const origin=await originPolicyCorpusSnapshot(client,input.installationId)
          if(origin.stamp!==originStamp)sourceInvalid=true
        }
        let admittedGeneration:string|undefined
        try{admittedGeneration=await fenceConsumptionGeneration(client,input.installationId,packRow.consumption_generation??undefined,{directPack})}
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
        const insertAdmission = (direct: boolean) => client.query<{ admission_expires_at: Date }>(`
          INSERT INTO memory_context_injections
            (injection_id, installation_id, pack_id, session_id, client_request_id,
             agent, adapter, admission_nonce_hmac, state, admitted_at, admission_expires_at,consumption_generation)
          SELECT $1, $2, $3, $4, $5, $6, $7, $8, 'admitted', clock_timestamp(),
                 clock_timestamp() + ($9 * INTERVAL '1 second'),$10
          WHERE ($11::double precision IS NULL OR clock_timestamp()<to_timestamp($11::double precision))
          ${direct?`AND EXISTS (
            SELECT 1 FROM memory_context_packs p
            WHERE p.installation_id=$2 AND p.pack_id=$3 AND p.selected_references='[]'::jsonb
              AND NOT EXISTS (${DIRECT_MACHINE_PACK_VERSIONS_SQL})
          )`:''}
          RETURNING admission_expires_at
        `, [injectionId, input.installationId, input.packId, input.sessionId,
          input.clientRequestId, input.agent, input.adapter, nonceHmac, ttl,admittedGeneration,nativeGrant?.expiresAt??null])
        // A direct pack can prove the absence of machine sources in the
        // nonce INSERT itself. All other packs keep the full source fence.
        let inserted = directPack ? await insertAdmission(true) : undefined
        if (!inserted?.rowCount) {
          await fenceMachinePackSources(client,input.installationId,input.packId,input.authorityGrant,Boolean(nativeGrant))
          inserted = await insertAdmission(false)
        }
        if (!inserted.rowCount) {
          await client.query('ROLLBACK')
          return { ok: false, error: 'claim_invalid' }
        }
        if(queryContext.selectedScopeProof){
          const proof=queryContext.selectedScopeProof,origins=await selectedScopeOriginFences(client,proof)
          if(!await lockOriginPolicyFences(client,origins.fences,sourcePoolContext(deps.pool).namespace)){await client.query('ROLLBACK');return{ok:false,error:'claim_invalid'}}
          const valid=await client.query<{valid:boolean}>(`SELECT ${selectedScopeFenceSql('$1')} AND ${originPolicyFenceSql('$2',sourcePoolContext(deps.pool).namespace)} AND ($3::double precision IS NULL OR clock_timestamp()<to_timestamp($3::double precision)) AS valid`,[JSON.stringify(proof),JSON.stringify(origins.fences),input.selectedScopeGrant?.expiresAt??null])
          if(!origins.matches||!valid.rows[0]?.valid){await client.query('ROLLBACK');return{ok:false,error:'claim_invalid'}}
        }
        await client.query('COMMIT')
        return { ok: true, injectionId, nonce, expiresAt: inserted.rows[0].admission_expires_at }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        if(error instanceof TargetBindingError||preparedSourceUnavailable(error)||['55P03','57014'].includes((error as {code?:string}).code??''))return{ok:false,error:'claim_invalid'}
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
      authorityGrant?:PackAuthorityGrant
      verifyInstallation?:boolean
    }): Promise<ConsumeResult> {
      const shared=sourcePoolContext(deps.pool).namespace==='memory'
      const grant = input.authorityGrant
      const selectedPrimary = shared && grant && 'scopeBindings' in grant
        && grant.primaryInstallationId === input.installationId
        ? grant.scopeBindings.find(binding=>binding.installation_id===input.installationId
          && binding.owner_scope_kind==='personal' && binding.membership_id===null
          && binding.permissions.includes('read')) : undefined
      const nativeGrant = shared && grant && !('scopeBindings' in grant) ? grant
        : selectedPrimary && grant && { installationId:input.installationId,configVersion:grant.configVersion,userId:grant.userId }
      if (nativeGrant && nativeGrant.installationId !== input.installationId) {
        return { ok: false, error: 'not_found' }
      }
      const frameFence=lifecycleFrameFenceSql('p',deps.lifecycleMode??'off',shared?'memory':'public')
      const machineSourcesSql=shared?`EXISTS (${MACHINE_PACK_VERSIONS_SQL})`:'FALSE'
      const currentMachineSourcesSql=`($10::boolean OR NOT (${machineSourcesSql}))`
      const unselectedSharedClaimSql=`(
        COALESCE(p.selected_references,'[]'::jsonb)='[]'::jsonb AND EXISTS(
          SELECT 1 FROM memory_context_pack_items item
          JOIN knowledge_claims c USING(installation_id,claim_id)
          WHERE item.installation_id=p.installation_id AND item.pack_id=p.pack_id AND c.owner_scope_kind<>'personal'
        ))`
      const client=await deps.pool.connect()
      try {
        // The bounded personal handoff touches one installation and injection.
        // PG13 can spend more time compiling its guard plan than executing it.
        await begin(client, physical || Boolean(nativeGrant), Boolean(nativeGrant))
        // Secure native V1 authority before locking the authenticated
        // installation and injection. Read current facts after the fence.
        const result:ConsumeResult=await (async()=>{
          if (nativeGrant && !await lockCurrentRelayAuthority(client, [input.installationId])) {
            if(input.verifyInstallation)await rejectStalePersonalGrant(client,nativeGrant)
            return { ok: false, error: 'not_found' }
          }
          const nonceHmac = createHmac('sha256', deps.nonceHmacKey).update(input.nonce).digest()
          const packSql=`SELECT j.injection_id,p.query_context,${machineSourcesSql} AS machine_sources
            FROM memory_context_injections j
            JOIN memory_context_packs p ON p.pack_id=j.pack_id AND p.installation_id=j.installation_id
            WHERE j.injection_id=$1 AND j.installation_id=${nativeGrant?'i.installation_id':'$2'}
              AND j.session_id=$3 AND j.pack_id=$4 AND j.admission_nonce_hmac=$5 AND j.state='admitted'
            FOR UPDATE OF j`
          const observed=(await client.query<{
            injection_id:string|null;query_context:ContextQueryFrame|null;machine_sources:boolean|null
            native_authority?:NativeInstallationState
            local_status?:string
            delivery_authority_sha256?:string|null
          }>(nativeGrant?`
            WITH installation AS MATERIALIZED (
              SELECT installation_id,local_status FROM memory_installations
              WHERE installation_id=$2 FOR SHARE
            )
            SELECT i.local_status,authority.state AS native_authority,pack.*,
              CASE WHEN ${personalLifecycleAuthorityStateSql('authority.state')}
                THEN ${personalLifecycleDeliveryStampSql('i.installation_id',personalLifecycleAuthorityStampSql('authority.state'))}
              END AS delivery_authority_sha256
            FROM installation i
            LEFT JOIN LATERAL shared.memory_current_grant_states(ARRAY[i.installation_id],ARRAY[]::uuid[]) authority ON TRUE
            LEFT JOIN LATERAL (${packSql}) pack ON i.local_status='ready'
          `:packSql,[input.injectionId,input.installationId,input.sessionId,input.packId,nonceHmac])).rows[0]
          const nativeCurrent = !nativeGrant || matchesPersonalGrant(observed?.native_authority, nativeGrant)
            && (!selectedPrimary || (observed?.native_authority?.authorization_epoch===selectedPrimary.authorization_epoch
              && observed.native_authority.owner_scope_id===selectedPrimary.owner_scope_id))
          if(input.verifyInstallation&&(!nativeCurrent||!observed?.local_status
            ||['purging','purged','integrity_error'].includes(observed.local_status))){
            throw new MemoryApiError('unauthorized','grant rejected')
          }
          const frozen = nativeCurrent && observed?.injection_id && (!nativeGrant||observed.local_status==='ready') ? observed : undefined
          const proof=frozen?.query_context?.selectedScopeProof
          const verifyEmptyOriginAtHandoff=Boolean(physical&&nativeGrant&&frozen&&!proof
            && frozen.query_context?.originPolicyStamp==null)
          const origin=frozen&&!verifyEmptyOriginAtHandoff
            ? await originPolicyCorpusSnapshot(client,input.installationId) : {stamp:null,fences:[]}
          // A pack without an origin stamp was compiled against an empty
          // origin-policy corpus. Keep the observation from the nonce
          // transition for the expiration path if a concurrent writer changes it.
          const emptyOriginFence=verifyEmptyOriginAtHandoff
            ? '(SELECT absent FROM origin_observation)'
            : 'TRUE'
          // The direct branch has neither origin fences nor a selected-scope
          // proof. Avoid planning their joins while still checking the corpus
          // in the same snapshot as the nonce transition.
          const dependencyFence=verifyEmptyOriginAtHandoff
            ? "$7::jsonb='[]'::jsonb AND $8::jsonb='null'::jsonb"
            : `${originPolicyFenceSql('$7',sourcePoolContext(deps.pool).namespace)} AND ${selectedScopeFenceSql('$8')}`
          const observeOrigin=verifyEmptyOriginAtHandoff ? `
            WITH origin_observation AS MATERIALIZED (
              SELECT COALESCE((
                SELECT p.query_context->>'originPolicyStamp' IS NULL
                  AND NOT EXISTS (${originPolicyCorpusVersionsSql('p.installation_id')})
                FROM memory_context_packs p WHERE p.installation_id=$2 AND p.pack_id=$4
              ),FALSE) AS absent
            ), handoff AS (
          ` : ''
          const selected=proof?await selectedScopeOriginFences(client,proof):{matches:true,fences:[]}
          const selectionMatches=!proof||(!!input.selectedScopeGrant&&await selectedScopeContextCurrent(client,proof,input.selectedScopeGrant))
          const currentGrantDeadline=input.authorityGrant?.expiresAt??(proof?input.selectedScopeGrant?.expiresAt??null:null)
          const currentGrantClockSql="($9::double precision IS NULL OR clock_timestamp()<to_timestamp($9::double precision))"
          const originRows=[...origin.fences,...selected.fences],originLocked=await lockOriginPolicyFences(client,originRows,sourcePoolContext(deps.pool).namespace)
          const machineSources=frozen?.machine_sources===true
          const sourcesCurrent=nativeCurrent&&(!nativeGrant||!!frozen)&&(!machineSources||await machinePackSourcesAvailable(client,input.installationId,input.packId,input.authorityGrant))
          if(shared&&!physical&&!nativeGrant&&frozen&&!machineSources){
            await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
          }
          // The no-machine path avoids the machine source savepoint. The
          // atomic UPDATE still rejects a machine dependency added since the
          // earlier injection lock read, before it can return any pack text.
          const originMatches=sourcesCurrent&&originLocked&&(!frozen||origin.stamp===(frozen.query_context?.originPolicyStamp??null))&&selected.matches&&selectionMatches
          const originFences=JSON.stringify(originRows)
          const selectionProof=JSON.stringify(proof??null)
          const consumeParameters=[input.injectionId,input.installationId,input.sessionId,input.packId,nonceHmac,
            originMatches,originFences,selectionProof,currentGrantDeadline,machineSources]
          const consumed = await client.query<{
            pack_id: string | null
            stable_text: string
            dynamic_text: string
            stable_hash: Buffer | null
            dynamic_hash: Buffer | null
            origin_absent?: boolean
          }>(`
            ${observeOrigin}
            UPDATE memory_context_injections j
            SET state = 'prepared'${shared?`, native_delivery_authority_sha256=$11,
              native_delivery_prepared_at=CASE WHEN $11::text IS NOT NULL THEN clock_timestamp() END`:''}
            FROM memory_context_packs p
            WHERE j.injection_id = $1 AND j.installation_id = $2
              AND j.session_id = $3 AND j.pack_id = $4
              AND j.state = 'admitted' AND j.admission_expires_at >= clock_timestamp()
              AND j.admission_nonce_hmac = $5
              AND p.pack_id = j.pack_id AND p.installation_id = j.installation_id
              AND $6::boolean AND ${emptyOriginFence} AND ${dependencyFence} AND ${currentGrantClockSql}
              AND p.state = 'ready' AND NOT ${unselectedSharedClaimSql} AND ${frameFence} AND ${currentMachineSourcesSql} AND NOT (${WIKI_SOURCE_TIME_INVALID_SQL})
              AND j.consumption_generation=COALESCE((SELECT generation FROM memory_scope_consumption_generations WHERE installation_id=p.installation_id),1)
              AND NOT EXISTS(SELECT 1 FROM memory_context_pack_items item JOIN knowledge_versions version ON version.installation_id=item.installation_id AND version.version_id=item.version_id
                WHERE item.pack_id=p.pack_id AND (NOT ${deliveryVersionAvailableSql('version')} OR NOT ${revisionTimeSql('version')} OR (version.valid_from IS NOT NULL AND version.valid_from>clock_timestamp()) OR (version.valid_until IS NOT NULL AND version.valid_until<=clock_timestamp())))
            RETURNING p.pack_id::text, p.stable_text, p.dynamic_text,
                      p.stable_hash, p.dynamic_hash
            ${verifyEmptyOriginAtHandoff ? `) SELECT handoff.*,origin_observation.absent AS origin_absent
              FROM origin_observation LEFT JOIN handoff ON TRUE` : ''}
          `, shared?[...consumeParameters,frozen?.delivery_authority_sha256??null]:consumeParameters)
          const row = consumed.rows[0]
          if (row?.pack_id) {
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
          const originWasCurrent=originMatches&&(!verifyEmptyOriginAtHandoff||row?.origin_absent===true)
          const state = await client.query<{ state: string; expired: boolean }>(`
            UPDATE memory_context_injections j
            SET state = CASE WHEN j.state = 'admitted' AND (NOT $6::boolean OR NOT ${frameFence} OR NOT (${currentGrantClockSql}) OR NOT (${dependencyFence}) OR NOT (${currentMachineSourcesSql}) OR ${WIKI_SOURCE_TIME_INVALID_SQL} OR j.admission_expires_at < clock_timestamp() OR p.state<>'ready' OR ${unselectedSharedClaimSql}
              OR j.consumption_generation IS NULL OR j.consumption_generation<>COALESCE((SELECT generation FROM memory_scope_consumption_generations WHERE installation_id=p.installation_id),1)
              OR EXISTS(SELECT 1 FROM memory_context_pack_items item JOIN knowledge_versions version ON version.installation_id=item.installation_id AND version.version_id=item.version_id
                WHERE item.pack_id=p.pack_id AND (NOT ${deliveryVersionAvailableSql('version')} OR NOT ${revisionTimeSql('version')} OR (version.valid_from IS NOT NULL AND version.valid_from>clock_timestamp()) OR (version.valid_until IS NOT NULL AND version.valid_until<=clock_timestamp()))))
              THEN 'expired' ELSE j.state END,
              outcome_code=CASE WHEN j.state='admitted' AND j.admission_expires_at>=clock_timestamp() THEN 'consumption_context_changed' ELSE j.outcome_code END
            FROM memory_context_packs p
            WHERE j.injection_id = $1 AND j.installation_id = $2 AND j.session_id = $3 AND j.pack_id = $4
              AND j.admission_nonce_hmac=$5 AND p.pack_id=j.pack_id AND p.installation_id=j.installation_id
            RETURNING j.state, j.admission_expires_at < clock_timestamp() AS expired
          `, [input.injectionId, input.installationId, input.sessionId, input.packId,nonceHmac,originWasCurrent,originFences,selectionProof,currentGrantDeadline,machineSources])
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
        if(nativeGrant&&['55P03','57014'].includes((error as {code?:string}).code??''))return{ok:false,error:'not_found'}
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
      const writeReceipt = async (db: Pick<pg.Pool,'query'>): Promise<ReceiptResult> => {
        const result = await db.query<{ state: 'delivered' | 'delivery_failed' }>(`
          UPDATE memory_context_injections
          SET state = CASE WHEN $3 THEN 'delivered' ELSE 'delivery_failed' END,
              delivered_at = CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,
              outcome_code = COALESCE($4, outcome_code)
          WHERE injection_id = $1 AND installation_id = $2 AND session_id = $5 AND state = 'prepared'
          RETURNING state
        `, [input.injectionId, input.installationId, input.delivered, input.outcomeCode ?? null, input.sessionId])
        // A separate statement sees a concurrent winner after UPDATE waited for
        // it. A terminal acknowledgement never fires another state trigger.
        const row = result.rows[0] ?? (await db.query<{state:'delivered'|'delivery_failed'}>(`
          SELECT state FROM memory_context_injections
          WHERE injection_id=$1 AND installation_id=$2 AND session_id=$3 AND state IN('delivered','delivery_failed')
        `,[input.injectionId,input.installationId,input.sessionId])).rows[0]
        if (!row) {
            return { ok: false, error: 'not_found' }
        }
        return { ok: true, state: row.state }
      }
      if (sourcePoolContext(deps.pool).namespace!=='memory') return writeReceipt(deps.pool)
      const client = await deps.pool.connect()
      try {
        await client.query("BEGIN;SET LOCAL statement_timeout='1s';SET LOCAL lock_timeout='250ms'")
        const result = await writeReceipt(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(()=>undefined)
        throw error
      } finally { client.release() }
    },
  }
}

function transactionPoolFromClient(client: pg.PoolClient): pg.Pool {
  return createTransactionBoundPool(client)
}

export type AdmissionService = ReturnType<typeof createAdmissionService>
