import {createMemoryPool} from '../db.js'
import {inspectCurationRecovery} from './recover-checkpoints.js'

const [action,installationId,...runIds]=process.argv.slice(2)
if(action==='--help'){
  console.log('Usage: curation:recover plan|apply INSTALLATION_UUID RUN_UUID [RUN_UUID ...] (maximum 25). Uses MEMORY_DATABASE_URL.')
}else if(!['plan','apply'].includes(action)||!installationId||!runIds.length||!process.env.MEMORY_DATABASE_URL){
  console.error('Expected plan or apply, an installation UUID, exact run UUIDs, and MEMORY_DATABASE_URL.')
  process.exitCode=2
}else{
  const pool=createMemoryPool({databaseUrl:process.env.MEMORY_DATABASE_URL,databaseNamespace:'memory',dbPoolMax:2})
  try{
    const rows=await inspectCurationRecovery(pool,{installationId,runIds,apply:action==='apply'})
    console.log(JSON.stringify(rows,null,2))
    if(rows.some(row=>['source_changed','unavailable','unverified','lock_wait','timed_out'].includes(row.disposition)))process.exitCode=1
  }catch(error){
    console.error(error instanceof Error&&error.message==='invalid_curation_reconciliation_scope'
      ? error.message : 'curation_recovery_failed')
    process.exitCode=2
  }finally{await pool.end()}
}
