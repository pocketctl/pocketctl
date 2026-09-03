import { Registry, Counter, Gauge, Histogram } from 'prom-client'
import type pg from 'pg'

export async function updateFeedLagGauge(
  pool: Pick<pg.Pool, 'query'>,
  gauge: Pick<Gauge, 'set'>,
): Promise<void> {
  const lag = await pool.query<{ lag_seconds: string | null }>(`
    SELECT EXTRACT(EPOCH FROM (NOW() - MIN(COALESCE(last_pull_at, created_at))))::text AS lag_seconds
    FROM memory_installations
    WHERE relay_status IN ('pending', 'active')
      AND local_status IN ('discovering', 'syncing', 'ready', 'degraded')
      AND snapshot_required = FALSE
  `)
  gauge.set(Number(lag.rows[0]?.lag_seconds ?? 0))
}

/**
 * Bounded Prometheus metrics for the Memory service. Label names are frozen
 * low-cardinality allowlists (plan section 12): installation, session,
 * provider URL and error message labels are forbidden.
 */
export function createMemoryMetrics() {
  const registry = new Registry()
  const phase1 = createPhase1Metrics(registry)
  const phase4 = createPhase4Metrics(registry)
  const phase5 = createPhase5Metrics(registry)
  const phase6 = createPhase6Metrics(registry)

  const installations = new Gauge({
    name: 'pocketctl_memory_installations',
    help: 'Local installations by local state',
    labelNames: ['state'] as const,
    registers: [registry],
  })

  const feedPulls = new Counter({
    name: 'pocketctl_memory_feed_pulls_total',
    help: 'Relay feed pulls by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })

  const feedAcks = new Counter({
    name: 'pocketctl_memory_feed_acks_total',
    help: 'Relay feed acks by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })

  const feedLag = new Gauge({
    name: 'pocketctl_memory_feed_lag_seconds',
    help: 'Seconds between the newest relay feed row and its durable commit',
    registers: [registry],
  })

  const inboxRows = new Gauge({
    name: 'pocketctl_memory_inbox_rows',
    help: 'Durable inbox rows by projection state',
    labelNames: ['state'] as const,
    registers: [registry],
  })

  const projection = new Counter({
    name: 'pocketctl_memory_projection_total',
    help: 'Source projections by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })

  const jobs = new Gauge({
    name: 'pocketctl_memory_jobs',
    help: 'Background jobs by type and state; completed/dead reflect their retention windows (24h/7d)',
    labelNames: ['type', 'state'] as const,
    registers: [registry],
  })

  const snapshot = new Counter({
    name: 'pocketctl_memory_snapshot_total',
    help: 'Snapshot reconcile runs by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })

  const purge = new Counter({
    name: 'pocketctl_memory_purge_total',
    help: 'Purge operations by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })

  const relayRequests = new Counter({
    name: 'pocketctl_memory_relay_requests_total',
    help: 'Relay HTTP requests by operation and result',
    labelNames: ['operation', 'result'] as const,
    registers: [registry],
  })

  const relayDuration = new Histogram({
    name: 'pocketctl_memory_relay_request_duration_seconds',
    help: 'Relay HTTP request duration by operation',
    labelNames: ['operation'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  })

  const usageOutboxRows = new Gauge({
    name: 'pocketctl_memory_usage_outbox_rows',
    help: 'Usage outbox rows by state',
    labelNames: ['state'] as const,
    registers: [registry],
  })

  return {
    registry,
    installations,
    feedPulls,
    feedAcks,
    feedLag,
    inboxRows,
    projection,
    jobs,
    snapshot,
    purge,
    relayRequests,
    relayDuration,
    usageOutboxRows,
    phase1,
    phase4,
    phase5,
    phase6,
  }
}

export type MemoryMetrics = ReturnType<typeof createMemoryMetrics>

const SKILL_LEDGER_STATES = {
  task: ['pending','running','candidate','cancelled','dead'],
  candidate: ['candidate','superseded','revoked'],
  replay: ['running','passed','failed','cancelled'],
  execution: ['started','succeeded','failed','taken_over','cancelled'],
  review: ['approve','request_changes','reject'],
  review_outcome: ['accepted_as_is','light_edit','major_edit'],
  publication: ['manual','auto','rollback'],
} as const
const SKILL_PROVENANCE = ['ledger','fixture','recorded'] as const
export function createPhase5Metrics(registry = new Registry()) {
  const actions = new Counter({name:'pocketctl_memory_skill_actions_total',help:'Skill REST mutations by bounded action and authorization result',labelNames:['action','result'] as const,registers:[registry]})
  const admissions = new Counter({name:'pocketctl_memory_skill_admissions_total',help:'Skill admission outcomes, including deduplicated requests',labelNames:['result'] as const,registers:[registry]})
  const ledger = new Gauge({ name:'pocketctl_memory_skill_ledger_rows',help:'Retained Skill ledger rows; fixture/recorded are not natural executions',labelNames:['stage','state','provenance'] as const,registers:[registry] })
  const queueAge = new Gauge({ name:'pocketctl_memory_skill_queue_oldest_seconds',help:'Age of oldest pending Skill generation job',registers:[registry] })
  const retries = new Gauge({ name:'pocketctl_memory_skill_retained_retries',help:'Retry attempts of retained Skill jobs; job retention applies',registers:[registry] })
  const deadJobs = new Gauge({ name:'pocketctl_memory_skill_dead_jobs',help:'Retained Skill DLQ jobs',registers:[registry] })
  const naturalExecutions = new Gauge({name:'pocketctl_memory_skill_natural_executions',help:'Real Skill execution denominator; disabled by current product gate',registers:[registry]})
  const generation = new Counter({name:'pocketctl_memory_skill_generation_results_total',help:'Skill generator returns, including budget denials',labelNames:['result'] as const,registers:[registry]})
  const tokens = new Counter({name:'pocketctl_memory_skill_provider_tokens_total',help:'Reported Skill generation tokens; no model/identity labels',labelNames:['direction'] as const,registers:[registry]})
  const cost = new Counter({name:'pocketctl_memory_skill_provider_cost_micros_total',help:'Estimated Skill cost in micros from configured rates; unpriced usage is unknown',registers:[registry]})
  const costReports = new Counter({name:'pocketctl_memory_skill_provider_cost_reports_total',help:'Responses with an available Skill cost estimate',registers:[registry]})
  const revocationLag = new Histogram({name:'pocketctl_memory_skill_revocation_propagation_seconds',help:'Relay scope control recording to committed local invalidation; not an end-to-end client probe',buckets:[0.01,0.1,0.5,1,2,5,10,30,60],registers:[registry]})
  return {
    queueAge,retries,deadJobs,naturalExecutions,
    recordAdmission(result:'admitted'|'deduplicated'|'rejected'){if(['admitted','deduplicated','rejected'].includes(result))admissions.inc({result})},
    recordAction(action:'admission'|'review'|'replay'|'publish'|'revoke'|'rollback'|'policy'|'execution',result:'allowed'|'denied') {
      if(['admission','review','replay','publish','revoke','rollback','policy','execution'].includes(action)&&['allowed','denied'].includes(result))actions.inc({action,result})
    },
    setLedger(stage:string,state:string,provenance:string,count:number) {
      const states=SKILL_LEDGER_STATES[stage as keyof typeof SKILL_LEDGER_STATES] as readonly string[]|undefined
      if(!states?.includes(state)||!(SKILL_PROVENANCE as readonly string[]).includes(provenance)||!Number.isFinite(count)||count<0)return
      ledger.set({stage,state,provenance},count)
    },
    clearLedger() {for(const [stage,states] of Object.entries(SKILL_LEDGER_STATES))for(const state of states)for(const provenance of SKILL_PROVENANCE)ledger.set({stage,state,provenance},0)},
    recordGeneration(result:'success'|'failed'|'budget_denied',usage?:{inputTokens:number;outputTokens:number;costMicros?:number}) {
      if(!['success','failed','budget_denied'].includes(result))return
      generation.inc({result})
      if(!usage)return
      for(const [direction,value] of [['input',usage.inputTokens],['output',usage.outputTokens]] as const)if(Number.isFinite(value)&&value>=0)tokens.inc({direction},value)
      if(usage.costMicros!==undefined&&Number.isFinite(usage.costMicros)&&usage.costMicros>=0){cost.inc(usage.costMicros);costReports.inc()}
    },
    observeRevocationLag(seconds:number){if(Number.isFinite(seconds)&&seconds>=0)revocationLag.observe(seconds)},
  }
}
export type Phase5Metrics=ReturnType<typeof createPhase5Metrics>
const GIT_METRIC_STATES={observation:['completed','unfinished','failed'],canonical_change:['completed','partial','unfinished','failed','unattributed'],asset_outcome:['published','draft_appended','linked','revoked','unfinished']} as const
const GIT_METRIC_PROVENANCE=['fixture','shadow','consented_mpc','natural','unattributed'] as const
const GIT_OPERATIONS=['repository','merge','commit','tree','poll','write_tree','write_commit','write_branch','write_file','write_pull_request','reconcile']
const GIT_REQUEST_STATES=['reserved','responded','failed','aborted']
const GIT_DECISIONS=['approve','request_changes','reject']
const GIT_OPERATIONAL_STATES={
  observation:['received','verified','planned','duplicate','rejected','cancelled','invalidated','dead'],
  proposal:['received','verified','planned','awaiting_review','conflicted','awaiting_identity','applied','authorization_stale','cancelled','invalidated','dead','noop','purged_unfinished'],
  outbox_step:['pending','dispatching','reconciling','completed','conflicted'],
  job:['pending','running','completed','dead'],
} as const
const GIT_AGES=['unfinished_observation','reserved_request','pending_proposal','pending_job']
const GIT_MEASUREMENTS=['request_duration','review_duration','projection_invalidation','request_budget','byte_budget',...GIT_AGES]
export function createPhase6Metrics(registry=new Registry()) {
  const ledger=new Gauge({name:'pocketctl_memory_git_ledger_rows',help:'Durable Git observations, canonical eligible changes and asset outcomes; stages have distinct denominators; unattributed is legacy evidence',labelNames:['stage','state','provenance'] as const,registers:[registry]})
  const operational=new Map<string,{gauge:Gauge;labels:string[];allowed:readonly (readonly string[])[]}>()
  const add=(name:string,help:string,labels:string[]=[],allowed:readonly (readonly string[])[]=[])=>{
    const gauge=new Gauge({name:`pocketctl_memory_git_${name}`,help,labelNames:labels,registers:[registry]})
    if(name.startsWith('projection_invalidation_seconds_'))gauge.remove()
    operational.set(name,{gauge,labels,allowed})
  }
  add('request_rows','Retained request reservations, including unfinished and failed attempts',['operation','state'],[GIT_OPERATIONS,GIT_REQUEST_STATES])
  add('response_bytes','Known decompressed response bytes; reserved/aborted are lower bounds, not measured wire traffic',['operation','state'],[GIT_OPERATIONS,GIT_REQUEST_STATES])
  for(const suffix of ['sum','count']){
    add(`request_duration_seconds_${suffix}`,'Retained first terminal local request durations; excludes reservation and settlement SQL; missing rows omitted',['operation','state'],[GIT_OPERATIONS,GIT_REQUEST_STATES])
    add(`review_duration_seconds_${suffix}`,'Elapsed wall time from exact governed revision creation to recorded decision, not active reviewer labor',['decision'],[GIT_DECISIONS])
    add(`projection_invalidation_seconds_${suffix}`,'Per-export local DELETE trigger interval through synchronous FK cleanup; excludes earlier waits, outer commit, notification and remote cleanup')
  }
  add('operational_rows','Distinct retained observations/proposal identities/outbox steps, or current retained Git jobs; stages are separate denominators',['stage','state'],[Object.keys(GIT_OPERATIONAL_STATES),[...new Set(Object.values(GIT_OPERATIONAL_STATES).flat())]])
  add('reviews','Retained exact Git revision decisions, including superseded revisions',['decision'],[GIT_DECISIONS])
  add('cleanup_rows','Retained remote cleanup records; recognized pending remains unfinished',['state'],[['pending_unrecognized','pending_recognized','complete']])
  add('actions','Retained audit events; actions are not unique assets or requests',['action','outcome'],[['connection','mapping','snapshot','import','review','apply','dispatch','reconcile','invalidate','purge'],['allowed','denied','noop','invalidated','pending']])
  add('oldest_seconds','Age of oldest record in the named stage; absent without a valid sample',['stage'],[GIT_AGES])
  add('run_attempts','Sum of retained observation receipt HTTP attempts')
  add('run_failures','Sum of retained observation receipt failure counts')
  add('retry_attempts','Retry attempts of retained Git jobs beyond first attempt; job retention applies')
  add('budget_remaining','Sum of last recorded worker limit headroom on live nonterminal runs; observed-byte headroom is an upper bound, not current authorization',['unit'],[['requests','bytes']])
  add('budget_runs','Live nonterminal runs by last recorded limit headroom; unavailable historical limits stay unknown',['unit','state'],[['requests','bytes'],['available','exhausted','unknown']])
  add('measurement_available','One iff at least one valid measurement exists; partial missing samples remain separately counted',['measurement'],[GIT_MEASUREMENTS])
  add('measurement_missing_rows','Rows without the named usable measurement, including old records, unsettled requests and clock anomalies',['measurement'],[GIT_MEASUREMENTS])
  return {
    clearLedger(){ledger.reset()},
    clearOperational(){for(const [name,{gauge}] of operational){gauge.reset()
      // prom-client initializes an unlabelled Gauge to zero even after reset.
      // Remove that default: no measured interval must not look like zero lag.
      if(name.startsWith('projection_invalidation_seconds_'))gauge.remove()}},
    setOperational(name:string,values:string[],count:number){
      const spec=operational.get(name)
      if(!spec||!Number.isFinite(count)||count<0||values.length!==spec.labels.length||values.some((v,i)=>!spec.allowed[i]?.includes(v)))return
      if(name==='operational_rows'&&!(GIT_OPERATIONAL_STATES[values[0] as keyof typeof GIT_OPERATIONAL_STATES] as readonly string[])?.includes(values[1]))return
      spec.gauge.set(Object.fromEntries(spec.labels.map((label,i)=>[label,values[i]])),count)
    },
    setLedger(stage:string,state:string,provenance:string,count:number){
      const states=GIT_METRIC_STATES[stage as keyof typeof GIT_METRIC_STATES] as readonly string[]|undefined
      if(!states?.includes(state)||!(GIT_METRIC_PROVENANCE as readonly string[]).includes(provenance)||!Number.isFinite(count)||count<0)return
      ledger.set({stage,state,provenance},count)
    },
  }
}
export type Phase6Metrics=ReturnType<typeof createPhase6Metrics>
export async function updatePhase6Gauges(pool:Pick<pg.Pool,'query'>,metrics:Phase6Metrics):Promise<void> {
  const result=await pool.query<{stage:string;state:string;provenance:string;count:string}>(`WITH outcomes AS (
      SELECT DISTINCT ON(installation_id,proposal_id) installation_id,proposal_id,outcome FROM (
        SELECT installation_id,proposal_id,outcome FROM memory_git_import_outcomes
        UNION ALL SELECT installation_id,proposal_id,outcome FROM memory_git_retained_outcomes
      ) o ORDER BY installation_id,proposal_id
    ), assets AS (
      SELECT i.installation_id,i.connection_id,i.export_id,i.proposal_id,b.run_id,COALESCE(r.outcome_kind,'unattributed') AS provenance,o.outcome
      FROM memory_git_proposal_identities i LEFT JOIN memory_git_proposal_runs b USING(installation_id,connection_id,proposal_id)
      LEFT JOIN memory_git_run_receipts r ON r.installation_id=b.installation_id AND r.run_id=b.run_id
      LEFT JOIN outcomes o ON o.installation_id=i.installation_id AND o.proposal_id=i.proposal_id
    ), canonical AS (
      SELECT r.installation_id,r.run_id,r.outcome_kind,r.failures,r.state,r.unfinished,COUNT(a.proposal_id) AS expected,COUNT(a.outcome) AS completed,
        bool_or(EXISTS(SELECT 1 FROM assets unknown WHERE unknown.installation_id=a.installation_id AND unknown.connection_id=a.connection_id AND unknown.export_id=a.export_id AND unknown.run_id IS NULL)) AS unattributed
      FROM memory_git_run_receipts r LEFT JOIN assets a ON a.installation_id=r.installation_id AND a.run_id=r.run_id
      WHERE r.eligible AND r.canonical_run_id IS NULL GROUP BY r.installation_id,r.run_id
    ), rows AS (
      SELECT 'observation' AS stage,CASE WHEN failures>0 THEN 'failed' WHEN unfinished THEN 'unfinished' ELSE 'completed' END AS state,outcome_kind AS provenance FROM memory_git_run_receipts
      UNION ALL SELECT 'canonical_change',CASE WHEN completed>0 AND unattributed THEN 'unattributed' WHEN expected>0 AND completed=expected THEN 'completed' WHEN completed>0 THEN 'partial' WHEN failures>0 OR state IN('dead','rejected') THEN 'failed' ELSE 'unfinished' END,outcome_kind FROM canonical
      UNION ALL SELECT 'asset_outcome',COALESCE(outcome,'unfinished'),provenance FROM assets
    ) SELECT stage,state,provenance,COUNT(*)::text AS count FROM rows GROUP BY stage,state,provenance`)
  metrics.clearLedger()
  for(const row of result.rows)metrics.setLedger(row.stage,row.state,row.provenance,Number(row.count))
  // These queries aggregate durable metadata only. No body, path, repository,
  // tenant or credential can become a metric label.
  const requests=await pool.query<{operation:string;state:string;count:string;bytes:string;duration_count:string;duration_sum:string|null}>(`SELECT operation,state,COUNT(*)::text AS count,SUM(response_bytes)::text AS bytes,
    COUNT(duration_seconds)::text AS duration_count,SUM(duration_seconds)::text AS duration_sum FROM memory_git_request_reservations GROUP BY operation,state`)
  const rows=await pool.query<{stage:string;state:string;count:string}>(`WITH proposal AS (
    SELECT i.proposal_id,COALESCE(p.state,CASE WHEN o.proposal_id IS NOT NULL THEN 'applied' ELSE 'purged_unfinished' END) AS state
    FROM memory_git_proposal_identities i LEFT JOIN memory_git_import_proposals p USING(installation_id,connection_id,proposal_id)
    LEFT JOIN memory_git_retained_outcomes o USING(installation_id,connection_id,proposal_id)
  ), steps AS (
    SELECT DISTINCT ON(installation_id,connection_id,outbox_id,step) installation_id,connection_id,outbox_id,step,state FROM (
      SELECT installation_id,connection_id,outbox_id,step,state FROM memory_git_outbox_steps
      UNION ALL SELECT installation_id,connection_id,outbox_id,step,state FROM memory_git_retained_steps
    ) s ORDER BY installation_id,connection_id,outbox_id,step
  ), operational AS (
    SELECT 'observation' AS stage,state FROM memory_git_run_receipts UNION ALL SELECT 'proposal',state FROM proposal
    UNION ALL SELECT 'outbox_step',state FROM steps
    UNION ALL SELECT 'job',state FROM memory_jobs WHERE job_type IN('git_ingest','git_export','git_reconcile')
  ) SELECT stage,state,COUNT(*)::text AS count FROM operational GROUP BY stage,state`)
  const reviews=await pool.query<{decision:string;count:string;duration_count:string;duration_sum:string|null}>(`WITH reviews AS (
    SELECT d.decision,CASE WHEN d.created_at>=r.created_at THEN EXTRACT(EPOCH FROM(d.created_at-r.created_at)) END AS seconds
    FROM memory_git_revision_reviews d JOIN memory_git_governed_revisions r USING(installation_id,revision_id)
  ) SELECT decision,COUNT(*)::text AS count,COUNT(seconds)::text AS duration_count,SUM(seconds)::text AS duration_sum FROM reviews GROUP BY decision`)
  const cleanup=await pool.query<{state:string;count:string}>(`SELECT CASE WHEN NOT cleanup_pending THEN 'complete' WHEN recognized_at IS NULL THEN 'pending_unrecognized' ELSE 'pending_recognized' END AS state,
    COUNT(*)::text AS count FROM memory_git_remote_cleanup GROUP BY 1`)
  const actions=await pool.query<{action:string;outcome:string;count:string}>('SELECT action,outcome,COUNT(*)::text AS count FROM memory_git_audit_events GROUP BY action,outcome')
  const invalidation=(await pool.query<{count:string;duration_count:string;duration_sum:string|null}>(`SELECT COUNT(*)::text AS count,COUNT(duration_seconds)::text AS duration_count,
    SUM(duration_seconds)::text AS duration_sum FROM memory_git_projection_invalidations`)).rows[0]
  const totals=(await pool.query<{attempts:string;failures:string;retries:string}>(`SELECT COALESCE(SUM(attempts),0)::text AS attempts,COALESCE(SUM(failures),0)::text AS failures,
    (SELECT COALESCE(SUM(GREATEST(attempts-1,0)),0)::text FROM memory_jobs WHERE job_type IN('git_ingest','git_export','git_reconcile')) AS retries FROM memory_git_run_receipts`)).rows[0]
  const ages=await pool.query<{stage:string;seconds:string|null;missing:string}>(`WITH pending AS (
    SELECT 'unfinished_observation' AS stage,created_at FROM memory_git_run_receipts WHERE unfinished
    UNION ALL SELECT 'reserved_request',created_at FROM memory_git_request_reservations WHERE state='reserved'
    UNION ALL SELECT 'pending_proposal',created_at FROM memory_git_import_proposals WHERE state IN('received','verified','planned','awaiting_review','conflicted','awaiting_identity')
    UNION ALL SELECT 'pending_job',created_at FROM memory_jobs WHERE job_type IN('git_ingest','git_export','git_reconcile') AND state='pending'
  ) SELECT stage,EXTRACT(EPOCH FROM(NOW()-MIN(created_at) FILTER(WHERE created_at<=NOW())))::text AS seconds,
    COUNT(*) FILTER(WHERE created_at>NOW())::text AS missing FROM pending GROUP BY stage`)
  const budgets=await pool.query<{unit:string;state:string;count:string;remaining:string|null}>(`WITH runs AS (
    SELECT r.installation_id,r.run_id,r.http_attempts,q.request_limit,q.byte_limit,
      (SELECT COALESCE(SUM(response_bytes),0) FROM memory_git_request_reservations a WHERE a.installation_id=r.installation_id AND a.run_id=r.run_id) AS bytes
    FROM memory_git_runs r LEFT JOIN LATERAL (SELECT request_limit,byte_limit FROM memory_git_request_reservations a
      WHERE a.installation_id=r.installation_id AND a.run_id=r.run_id ORDER BY attempt DESC LIMIT 1) q ON true
    WHERE r.state NOT IN('closed','cancelled','invalidated','dead')
  ), budget AS (
    SELECT 'requests' AS unit,request_limit-http_attempts AS remaining FROM runs
    UNION ALL SELECT 'bytes',byte_limit-bytes FROM runs
  ) SELECT unit,CASE WHEN remaining IS NULL THEN 'unknown' WHEN remaining<=0 THEN 'exhausted' ELSE 'available' END AS state,
    COUNT(*)::text AS count,SUM(GREATEST(remaining,0)) FILTER(WHERE remaining IS NOT NULL)::text AS remaining FROM budget GROUP BY 1,2`)
  metrics.clearOperational()
  const set=(name:string,labels:string[],value:unknown)=>metrics.setOperational(name,labels,Number(value))
  const measurement=(name:string,count:number,missing:number)=>{set('measurement_available',[name],count>0?1:0);set('measurement_missing_rows',[name],missing)}
  let requestCount=0,requestMissing=0,reviewCount=0,reviewMissing=0
  for(const row of requests.rows){const labels=[row.operation,row.state],count=Number(row.duration_count)
    set('request_rows',labels,row.count);set('response_bytes',labels,row.bytes)
    if(count){set('request_duration_seconds_count',labels,count);set('request_duration_seconds_sum',labels,row.duration_sum)}
    requestCount+=count;requestMissing+=Number(row.count)-count}
  measurement('request_duration',requestCount,requestMissing)
  for(const row of rows.rows)set('operational_rows',[row.stage,row.state],row.count)
  for(const row of reviews.rows){const count=Number(row.duration_count);set('reviews',[row.decision],row.count)
    if(count){set('review_duration_seconds_count',[row.decision],count);set('review_duration_seconds_sum',[row.decision],row.duration_sum)}
    reviewCount+=count;reviewMissing+=Number(row.count)-count}
  measurement('review_duration',reviewCount,reviewMissing)
  for(const row of cleanup.rows)set('cleanup_rows',[row.state],row.count)
  for(const row of actions.rows)set('actions',[row.action,row.outcome],row.count)
  const invalidationCount=Number(invalidation?.duration_count??0)
  measurement('projection_invalidation',invalidationCount,Number(invalidation?.count??0)-invalidationCount)
  if(invalidationCount){set('projection_invalidation_seconds_count',[],invalidationCount);set('projection_invalidation_seconds_sum',[],invalidation.duration_sum)}
  set('run_attempts',[],totals.attempts);set('run_failures',[],totals.failures);set('retry_attempts',[],totals.retries)
  for(const stage of GIT_AGES){const row=ages.rows.find(r=>r.stage===stage),available=row?.seconds!==null&&row?.seconds!==undefined
    measurement(stage,available?1:0,Number(row?.missing??0));if(available)set('oldest_seconds',[stage],row!.seconds)}
  for(const unit of ['requests','bytes']){const selected=budgets.rows.filter(r=>r.unit===unit),known=selected.filter(r=>r.state!=='unknown')
    for(const state of ['available','exhausted','unknown'])set('budget_runs',[unit,state],selected.find(r=>r.state===state)?.count??0)
    measurement(unit==='requests'?'request_budget':'byte_budget',known.reduce((n,r)=>n+Number(r.count),0),Number(selected.find(r=>r.state==='unknown')?.count??0))
    if(known.length)set('budget_remaining',[unit],known.reduce((n,r)=>n+Number(r.remaining),0))}
}
export async function updatePhase5Gauges(pool:Pick<pg.Pool,'query'>,metrics:Phase5Metrics):Promise<void>{
  const rows=await pool.query<{stage:string;state:string;provenance:string;count:string}>(`
    SELECT 'task' AS stage,state,'ledger' AS provenance,COUNT(*)::text AS count FROM memory_skill_tasks GROUP BY state
    UNION ALL SELECT 'candidate',state,'ledger',COUNT(*)::text FROM memory_skill_candidates GROUP BY state
    UNION ALL SELECT 'replay',r.state,c.provenance,COUNT(DISTINCT r.run_id)::text FROM memory_skill_replay_runs r JOIN memory_skill_replay_cases c USING(installation_id,run_id) GROUP BY r.state,c.provenance
    UNION ALL SELECT 'execution',state,provenance,COUNT(*)::text FROM memory_skill_executions GROUP BY state,provenance
    UNION ALL SELECT 'review',decision,'ledger',COUNT(*)::text FROM memory_skill_review_decisions GROUP BY decision
    UNION ALL SELECT 'review_outcome',review_outcome,'ledger',COUNT(*)::text FROM memory_skill_review_decisions WHERE review_outcome IS NOT NULL GROUP BY review_outcome
    UNION ALL SELECT 'publication',mode,provenance,COUNT(*)::text FROM memory_skill_publication_events GROUP BY mode,provenance`)
  const queue=(await pool.query<{age:string;retries:string;dead:string}>(`SELECT COALESCE(EXTRACT(EPOCH FROM (NOW()-MIN(created_at) FILTER(WHERE state='pending'))),0)::text AS age,
    COALESCE(SUM(GREATEST(attempts-1,0)),0)::text AS retries,COUNT(*) FILTER(WHERE state='dead')::text AS dead FROM memory_jobs WHERE job_type='extract_skill_candidate'`)).rows[0]
  metrics.clearLedger()
  for(const row of rows.rows)metrics.setLedger(row.stage,row.state,row.provenance,Number(row.count))
  metrics.queueAge.set(Math.max(0,Number(queue?.age??0)));metrics.retries.set(Number(queue?.retries??0));metrics.deadJobs.set(Number(queue?.dead??0))
  metrics.naturalExecutions.set(0)
}


const EXTRACTION_RESULTS = new Set(['succeeded', 'failed', 'quarantined', 'skipped'])
const EXTRACTION_MODES = new Set(['shadow', 'enabled'])
const TOKEN_DIRECTIONS = new Set(['input', 'output'])
const CANDIDATE_STATUSES = new Set([
  'shadow', 'validated', 'duplicate', 'conflict',
  'rejected_by_validator', 'rejected', 'accepted',
])
const REVIEW_DECISIONS = new Set([
  'accepted_as_is', 'light_edit', 'major_edit', 'rejected',
])
const INDEX_RESULTS = new Set(['success', 'failed', 'skipped', 'degraded'])
const SEARCH_DEGRADED = new Set(['none', 'embedding'])
const FEEDBACK_ACTIONS = new Set([
  'candidate_accepted', 'candidate_corrected', 'candidate_rejected',
  'claim_corrected', 'claim_expired', 'claim_revoked', 'claim_deleted',
  'recall_used', 'recall_incorrect', 'recall_not_useful',
])
const PURGE_SCOPES = new Set(['session', 'installation', 'claim'])

function labelAllowed(set: Set<string>, value: string): boolean {
  return set.has(value)
}

/**
 * Phase 1 bounded metrics: extraction outcome/latency/tokens/cost, candidate
 * status, review decisions, indexing, search latency/results/degraded mode,
 * recall feedback, and purge invalidations. Labels come from the frozen
 * allowlists above — never query/claim/evidence text, session ids, paths,
 * grants or model output.
 */
export function createPhase1Metrics(registry = new Registry()) {

  const extractionRuns = new Counter({
    name: 'pocketctl_memory_extraction_runs_total',
    help: 'Candidate extraction runs by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })
  const extractionLatency = new Histogram({
    name: 'pocketctl_memory_extraction_latency_seconds',
    help: 'Candidate extraction wall latency by mode',
    labelNames: ['mode'] as const,
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
    registers: [registry],
  })
  const extractionTokens = new Counter({
    name: 'pocketctl_memory_extraction_tokens_total',
    help: 'Extraction model tokens by direction',
    labelNames: ['direction'] as const,
    registers: [registry],
  })
  const extractionCostMicros = new Counter({
    name: 'pocketctl_memory_extraction_cost_micros_total',
    help: 'Extraction model cost in micros when reported by the adapter',
    registers: [registry],
  })
  const candidateStatus = new Counter({
    name: 'pocketctl_memory_candidate_status_total',
    help: 'Candidates by deterministic status',
    labelNames: ['status'] as const,
    registers: [registry],
  })
  const reviewDecisions = new Counter({
    name: 'pocketctl_memory_review_decisions_total',
    help: 'Human review decisions',
    labelNames: ['decision'] as const,
    registers: [registry],
  })
  const indexJobs = new Counter({
    name: 'pocketctl_memory_index_jobs_total',
    help: 'Claim index jobs by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })
  const searchLatency = new Histogram({
    name: 'pocketctl_memory_search_latency_seconds',
    help: 'Claim search latency by degraded mode',
    labelNames: ['degraded'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 1.5, 3, 5],
    registers: [registry],
  })
  const searchResults = new Histogram({
    name: 'pocketctl_memory_search_results',
    help: 'Claim search hit counts by degraded mode',
    labelNames: ['degraded'] as const,
    buckets: [0, 1, 3, 5, 10, 20],
    registers: [registry],
  })
  const recallFeedback = new Counter({
    name: 'pocketctl_memory_recall_feedback_total',
    help: 'Recall feedback actions',
    labelNames: ['action'] as const,
    registers: [registry],
  })
  const purgeInvalidations = new Counter({
    name: 'pocketctl_memory_purge_invalidations_total',
    help: 'Purge-driven content invalidations by scope',
    labelNames: ['scope'] as const,
    registers: [registry],
  })

  return {
    registry,
    extractionRuns,
    extractionLatency,
    extractionTokens,
    extractionCostMicros,
    candidateStatus,
    reviewDecisions,
    indexJobs,
    searchLatency,
    searchResults,
    recallFeedback,
    purgeInvalidations,
    extractionLabelAllowed(name: string, value: string): boolean {
      if (name === 'result') return labelAllowed(EXTRACTION_RESULTS, value)
      if (name === 'mode') return labelAllowed(EXTRACTION_MODES, value)
      if (name === 'direction') return labelAllowed(TOKEN_DIRECTIONS, value)
      if (name === 'status') return labelAllowed(CANDIDATE_STATUSES, value)
      return false
    },
    searchLabelAllowed(name: string, value: string): boolean {
      if (name === 'degraded') return labelAllowed(SEARCH_DEGRADED, value)
      return false
    },
    reviewLabelAllowed(name: string, value: string): boolean {
      if (name === 'decision') return labelAllowed(REVIEW_DECISIONS, value)
      return false
    },
    feedbackLabelAllowed(name: string, value: string): boolean {
      if (name === 'action') return labelAllowed(FEEDBACK_ACTIONS, value)
      return false
    },
  }
}

export type Phase1Metrics = ReturnType<typeof createPhase1Metrics>

const PHASE4_LABELS: Readonly<Record<string, Readonly<Record<string, ReadonlySet<string>>>>> = {
  code_snapshots: {
    result: new Set(['accepted', 'rejected', 'aborted', 'purged']),
    source_kind: new Set(['personal', 'shared']),
  },
  code_snapshot_bytes: {
    language_class: new Set(['typescript', 'javascript', 'file_only', 'unsupported', 'excluded']),
  },
  codegraph_runs: {
    mode: new Set(['shadow', 'enabled']),
    result: new Set(['succeeded', 'failed', 'cancelled', 'stale_generation', 'skipped']),
    incremental: new Set(['true', 'false']),
  },
  codegraph_nodes: { kind: new Set(['file', 'symbol', 'external']) },
  codegraph_edges: {
    kind: new Set(['definition', 'import', 'dependency', 'reference', 'call', 'test']),
    resolution: new Set(['resolved', 'unresolved', 'dynamic']),
  },
  codegraph_impact: {
    result: new Set(['complete', 'partial', 'unsupported', 'degraded', 'not_found']),
  },
  wiki_builds: {
    mode: new Set(['shadow', 'enabled']),
    result: new Set(['succeeded', 'failed', 'cancelled', 'stale_generation', 'skipped']),
  },
  wiki_stale_sections: {
    reason: new Set(['source_file_changed', 'source_symbol_changed', 'binding_removed', 'graph_rebuilt']),
  },
  wiki_publications: {
    result: new Set(['published', 'rejected', 'conflict', 'unauthorized', 'stale_generation']),
  },
  wiki_manual_actions: {
    action: new Set(['edit', 'lock', 'unlock']),
    result: new Set(['succeeded', 'rejected', 'conflict', 'unauthorized']),
  },
}

const PHASE4_LOG_FIELDS = new Set([
  'request_id', 'job_id', 'run_id', 'result', 'error_code',
  'count', 'duration_ms', 'mode', 'content_hash',
])

/** Names are checked before structured fields reach the logger. */
export function phase4LogFieldAllowed(name: string): boolean {
  return PHASE4_LOG_FIELDS.has(name)
}

/** Phase 4 CodeGraph/Wiki metrics with only frozen, low-cardinality labels. */
export function createPhase4Metrics(registry = new Registry()) {
  const codeSnapshots = new Counter({
    name: 'pocketctl_memory_code_snapshot_total',
    help: 'Immutable code snapshot lifecycle outcomes',
    labelNames: ['result', 'source_kind'] as const,
    registers: [registry],
  })
  const codeSnapshotBytes = new Counter({
    name: 'pocketctl_memory_code_snapshot_bytes',
    help: 'Accepted immutable source bytes by bounded language class',
    labelNames: ['language_class'] as const,
    registers: [registry],
  })
  const codegraphRuns = new Counter({
    name: 'pocketctl_memory_codegraph_runs_total',
    help: 'CodeGraph build runs by mode, result, and incremental strategy',
    labelNames: ['mode', 'result', 'incremental'] as const,
    registers: [registry],
  })
  const codegraphNodes = new Gauge({
    name: 'pocketctl_memory_codegraph_nodes',
    help: 'Active CodeGraph nodes by bounded kind',
    labelNames: ['kind'] as const,
    registers: [registry],
  })
  const codegraphEdges = new Gauge({
    name: 'pocketctl_memory_codegraph_edges',
    help: 'Active CodeGraph edges by bounded kind and resolution',
    labelNames: ['kind', 'resolution'] as const,
    registers: [registry],
  })
  const codegraphImpact = new Counter({
    name: 'pocketctl_memory_codegraph_impact_total',
    help: 'Bounded impact analysis requests by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })
  const wikiBuilds = new Counter({
    name: 'pocketctl_memory_wiki_builds_total',
    help: 'Wiki candidate builds by mode and result',
    labelNames: ['mode', 'result'] as const,
    registers: [registry],
  })
  const wikiStaleSections = new Gauge({
    name: 'pocketctl_memory_wiki_stale_sections',
    help: 'Active Wiki stale sections by bounded reason',
    labelNames: ['reason'] as const,
    registers: [registry],
  })
  const wikiPublications = new Counter({
    name: 'pocketctl_memory_wiki_publications_total',
    help: 'Atomic Wiki publication attempts by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })
  const wikiManualActions = new Counter({
    name: 'pocketctl_memory_wiki_manual_actions_total',
    help: 'Manual and locked Wiki actions by action and result',
    labelNames: ['action', 'result'] as const,
    registers: [registry],
  })

  return {
    registry,
    codeSnapshots,
    codeSnapshotBytes,
    codegraphRuns,
    codegraphNodes,
    codegraphEdges,
    codegraphImpact,
    wikiBuilds,
    wikiStaleSections,
    wikiPublications,
    wikiManualActions,
    labelAllowed(metric: string, label: string, value: string): boolean {
      return PHASE4_LABELS[metric]?.[label]?.has(value) ?? false
    },
  }
}

export type Phase4Metrics = ReturnType<typeof createPhase4Metrics>

const PHASE4_NODE_KINDS = ['file', 'symbol', 'external'] as const
const PHASE4_EDGE_KINDS = ['definition', 'import', 'dependency', 'reference', 'call', 'test'] as const
const PHASE4_EDGE_RESOLUTIONS = ['resolved', 'unresolved', 'dynamic'] as const
const PHASE4_STALE_REASONS = [
  'source_file_changed', 'source_symbol_changed', 'binding_removed', 'graph_rebuilt',
] as const

/** Refresh Phase 4 gauges from active heads/projections only. */
export async function updatePhase4Gauges(
  pool: Pick<pg.Pool, 'query'>,
  metrics: Phase4Metrics,
): Promise<void> {
  const nodes = await pool.query<{ kind: string; count: string }>(`
    SELECT n.kind, COUNT(*)::text AS count
    FROM memory_code_nodes n
    JOIN memory_code_graph_heads h
      ON h.installation_id = n.installation_id
     AND h.active_graph_version_id = n.graph_version_id
    GROUP BY n.kind
  `)
  const nodeCounts = new Map(nodes.rows.map(row => [row.kind, Number(row.count)]))
  for (const kind of PHASE4_NODE_KINDS) {
    metrics.codegraphNodes.set({ kind }, nodeCounts.get(kind) ?? 0)
  }

  const edges = await pool.query<{ kind: string; resolution: string; count: string }>(`
    SELECT e.kind, e.resolution, COUNT(*)::text AS count
    FROM memory_code_edges e
    JOIN memory_code_graph_heads h
      ON h.installation_id = e.installation_id
     AND h.active_graph_version_id = e.graph_version_id
    GROUP BY e.kind, e.resolution
  `)
  const edgeCounts = new Map(edges.rows.map(row => [
    `${row.kind}:${row.resolution}`, Number(row.count),
  ]))
  for (const kind of PHASE4_EDGE_KINDS) {
    for (const resolution of PHASE4_EDGE_RESOLUTIONS) {
      metrics.codegraphEdges.set({ kind, resolution }, edgeCounts.get(`${kind}:${resolution}`) ?? 0)
    }
  }

  const stale = await pool.query<{ reason: string; count: string }>(`
    SELECT reason, COUNT(*)::text AS count
    FROM memory_wiki_stale_marks
    WHERE cleared_at IS NULL
    GROUP BY reason
  `)
  const staleCounts = new Map(stale.rows.map(row => [row.reason, Number(row.count)]))
  for (const reason of PHASE4_STALE_REASONS) {
    metrics.wikiStaleSections.set({ reason }, staleCounts.get(reason) ?? 0)
  }
}

// ---- Phase 2 context observability (plan 17): bounded outcome codes only —
// never query text, pack content, grants, paths or high-cardinality labels.

export interface Phase2ContextMetrics {
  contextCompiles: { inc(labels: { outcome: string; mode: string }): void }
  contextAdmissions: { inc(labels: { result: string }): void }
  contextDeliveries: { inc(labels: { state: string; adapter: string }): void }
  contextLatency: { observe(labels: { stage: string }, seconds: number): void }
  contextInvalidations: { inc(labels: { reason: string }): void }
}

export function createPhase2ContextMetrics(): Phase2ContextMetrics {
  const counters = new Map<string, number>()
  const histograms = new Map<string, number[]>()
  const bump = (map: Map<string, number>, key: string) => {
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return {
    contextCompiles: { inc: (labels) => bump(counters, `compile:${labels.outcome}:${labels.mode}`) },
    contextAdmissions: { inc: (labels) => bump(counters, `admit:${labels.result}`) },
    contextDeliveries: { inc: (labels) => bump(counters, `deliver:${labels.state}:${labels.adapter}`) },
    contextLatency: {
      observe: (labels, seconds) => {
        const key = `latency:${labels.stage}`
        const list = histograms.get(key) ?? []
        list.push(seconds)
        histograms.set(key, list)
      },
    },
    contextInvalidations: { inc: (labels) => bump(counters, `invalidate:${labels.reason}`) },
  }
}
