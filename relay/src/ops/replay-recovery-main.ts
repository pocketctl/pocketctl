import { readFile, writeFile } from 'node:fs/promises'
import pg from 'pg'
import {sessionLifecycleConfig} from '../session-lifecycle/config.js'
import {installConfiguredHistoryReader} from '../session-history/runtime.js'
import { planReplayRecovery, applyReplayRecovery, REPLAY_RECOVERY_AUDIT_SQL, type RecoveryManifest } from './replay-recovery.js'
import { safeMaterializationError } from '../inbox-worker.js'

const usage = `Usage (DATABASE_URL from a protected environment):
  node dist/ops/replay-recovery-main.js plan --daemon ID --owner N --generation N --ids /private/ids.json --out /private/manifest.json
  node dist/ops/replay-recovery-main.js install-audit
  node dist/ops/replay-recovery-main.js apply --manifest /private/manifest.json --digest SHA256 --workers-paused
IDs are an explicit JSON string array (1..100). plan is read-only. apply requires a reviewed digest and paused consumers.
Cold candidates require a configured archive reader; absent storage fails closed. See the recovery runbook.`
async function main() {
  const [command,...args]=process.argv.slice(2)
  if (!command || command==='--help') { console.log(usage);return }
  const flags=new Map<string,string>()
  for(let i=0;i<args.length;i++){
    const key=args[i]
    if(!['--daemon','--owner','--generation','--ids','--out','--manifest','--digest','--workers-paused'].includes(key) || flags.has(key))throw Error('invalid_arguments')
    const value=key==='--workers-paused'?'true':args[++i]
    if(!value || value.startsWith('--'))throw Error('invalid_arguments')
    const allowed:Record<string,string[]>={plan:['--daemon','--owner','--generation','--ids','--out'],apply:['--manifest','--digest','--workers-paused'],'install-audit':[]}
    if(!allowed[command]?.includes(key))throw Error('invalid_arguments')
    flags.set(key,value)
  }
  const required=(key:string)=>{const value=flags.get(key);if(!value)throw Error('missing_argument');return value}
  if(!process.env.DATABASE_URL)throw Error('database_url_required')
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,application_name:'relay-replay-recovery',connectionTimeoutMillis:5000})
  try {
    installConfiguredHistoryReader(pool,sessionLifecycleConfig(process.env))
    if(command==='plan') {
      const ids=JSON.parse(await readFile(required('--ids'),'utf8'))
      const manifest=await planReplayRecovery(pool,{daemonId:required('--daemon'),ownerId:Number(required('--owner')),generation:required('--generation')},ids)
      await writeFile(required('--out'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600})
      console.log(JSON.stringify({digest:manifest.digest,eligible:manifest.entries.length,excluded:manifest.excluded.length}))
    } else if(command==='install-audit') {
      if(flags.size)throw Error('invalid_arguments')
      await pool.query(REPLAY_RECOVERY_AUDIT_SQL);console.log(JSON.stringify({auditInstalled:true}))
    } else if(command==='apply') {
      const manifest=JSON.parse(await readFile(required('--manifest'),'utf8')) as RecoveryManifest
      console.log(JSON.stringify(await applyReplayRecovery(pool,manifest,required('--digest'),flags.get('--workers-paused')==='true')))
    } else throw Error('invalid_command')
  } finally { await pool.end() }
}
main().catch(error=>{
  // Never print driver errors/SQL parameters: they may contain event bodies.
  const known=new Set(['invalid_arguments','missing_argument','database_url_required','invalid_command','workers_must_be_paused','manifest_digest_mismatch','invalid_recovery_scope','recovery_target_mismatch','alias_set_changed','active_claims_present','audit_mismatch','candidate_changed','ineligible_dead_letter','stable_identity_required','alias_requires_review','completed_canonical_required','replay_marker_required','recovery_time_budget_exceeded'])
  const infrastructure:Record<string,string>={'55P03':'recovery_busy','57014':'recovery_timeout','42501':'recovery_permission_denied',EEXIST:'output_exists'}
  console.error(JSON.stringify({error:known.has(error?.message)?error.message:infrastructure[error?.code]??safeMaterializationError(error)}))
  process.exitCode=1
})
