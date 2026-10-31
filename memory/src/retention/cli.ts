import pg from 'pg'
import {previewSourceRetention,reclaimSourceTurn,type SourceRetentionSettings} from './source.js'
import {previewMigrationRetention,retainMigrationChanges,retainMigrationHistory} from './migrations.js'
import {createManagedInventoryReport,retainInventoryReports} from './reports.js'

async function main(){
 const [command='plan',...args]=process.argv.slice(2)
 if(!['plan','apply','report'].includes(command))throw new Error('invalid_retention_command')
 let directory:string|undefined,runId:string|undefined,batchSize=500
 for(let i=0;i<args.length;i++){const k=args[i],v=args[++i];if(!v)throw new Error('retention_argument_required')
  if(k==='--report-directory'&&!directory)directory=v;else if(k==='--migration-run-id'&&!runId)runId=v;else if(k==='--batch-size')batchSize=Number(v);else throw new Error('invalid_retention_argument')}
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>5000)throw new Error('invalid_retention_batch')
 if(runId&&(!/^[a-f0-9-]{36}$/i.test(runId)||command!=='report'))throw new Error('invalid_retention_migration_run')
 const url=process.env.MEMORY_MIGRATION_DATABASE_URL;if(!url)throw new Error('retention_database_required')
 const pool=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:5000,statement_timeout:30000})
 try{
  if(command==='report'){if(!directory)throw new Error('report_directory_required');console.log(JSON.stringify(await createManagedInventoryReport(pool,directory,runId)));return}
  const bodyDays=Number(process.env.MEMORY_SOURCE_BODY_RETENTION_DAYS??14)
  const source=await previewSourceRetention(pool,bodyDays),migrations=await previewMigrationRetention(pool)
  if(command==='plan'){console.log(JSON.stringify({readOnly:true,source,migrations,reportDirectory:directory?'managed_directory_configured':null},null,2));return}
  const settings:SourceRetentionSettings={mode:'enabled',bodyDays,batchSize,intervalMs:86400000}
  const results=[]
  for(const r of new Map([...source.reclaiming,...source.eligible].map(r=>[r.installation_id+':'+r.turn_id,r])).values())results.push(await reclaimSourceTurn(pool,{installationId:r.installation_id,sessionId:r.session_id,turnId:r.turn_id,episodeId:r.episode_id},settings))
  console.log(JSON.stringify({boundedPass:true,source:results,history:await retainMigrationHistory(pool,batchSize),changes:await retainMigrationChanges(pool,batchSize),reports:directory?await retainInventoryReports(pool,directory,batchSize):null},null,2))
 }finally{await pool.end()}
}
main().catch(()=>{console.error('Memory retention failed; credentials and source content are omitted.');process.exitCode=1})
