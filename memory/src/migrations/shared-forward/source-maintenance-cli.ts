import {planPagedCleanup,applyPagedCleanup,verifyPagedCleanup} from './paged-cleanup.js'
import {planForwardCleanup,applyForwardCleanup,verifyForwardCleanup,type ForwardCleanupManifest} from './forward-cleanup.js'
import {lstat,readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {ReportBundle} from '../shared-source/report.js'
import {safeError} from '../shared-source/database.js'
import {cancelSourceMaintenance} from './source-maintenance-common.js'
import {planSourceFence,applySourceFence,verifySourceFence,type SourceFenceConfig,type SourceFenceManifest} from './source-fence.js'
import {planPrivacyOverlay,applyPrivacyOverlay,verifyPrivacyOverlay,type PrivacyOverlayConfig,type PrivacyOverlayManifest} from './privacy-overlay.js'
export const maintenanceHelp=`Dedicated administrator-only source maintenance. No application/schema/worker startup.
  fence|overlay|cleanup plan --config FILE --output NEW_DIR
  fence|overlay|cleanup apply|verify --config FILE --manifest FILE --output NEW_DIR
  cleanup resume --config FILE --manifest FILE --output NEW_DIR
  paged-cleanup plan --config FILE --roots FILE --output NEW_DIR
  paged-cleanup apply|resume|verify --config FILE --manifest DIR --output NEW_DIR
Paged v4 config also requires the independently reviewed catalog hash:
reviewedCatalogHash. Roots FILE is a private JSON array of exact
{installationId,sessionId} objects. Plan output is the immutable private v4
manifest directory; apply/resume/verify output is a separate receipt directory.
Existing cleanup versions 1/2/3 keep their original contracts. No conversion.
Paged v4 plans all parts before loading/sealing administrator-only metadata;
only explicit apply installs that exact audited metadata schema. Native effects
remain bounded at1024 rows/8MiB, SQL5s/lock1s/physical10s. Unknown source mapping,
original owner/header/provenance, unsupported lifecycle/graph adapters refuse.
No v4 partial prefix is reopening readiness; the global target stays closed.
Connection URL: SHARED_MAINTENANCE_URL only; never a runtime DSN or CLI flag.
Config FILE (0600): {database:{expected:{database,databaseOid,role,serverAddress,serverPort}},units:{api,worker,freshInstall:false}}.
Fence adds oldMemoryRole, targetRoles:[...], reviewedConnectRoles:[...].
Overlay adds installationIds:[exact reviewed UUIDs], at most 16 installations.
Prerequisites: dedicated administrator; both API and Worker units loaded/inactive/MainPID=0.
not-found units require explicit freshInstall:true. systemctl probes run outside transactions.
Fence/overlay version 2 manifests; cleanup versions 1/2/3 embed the reviewed overlay.
Cleanup plan additionally requires --overlay FILE. Cleanup apply/resume reuse its
immutable manifest and durable per-object SQL checkpoints, including lost COMMIT
responses. SHARED_MAINTENANCE_TOMBSTONE_KEYS supplies the current trusted JSON
keyring [{version,key}]; no invented keys or key material in config/reports.
Cleanup admits at most 1024 affected dependency rows / 8 MiB per reviewed page,
uses short per-object transactions, and refuses larger policy dependency closures.
Plan/verify never install checkpoint DDL; explicit cleanup apply does.
Exact relational dependency hashes and fixed catalog roster require a coordinated
exclusive maintenance window; unrelated Session bodies are never global-hashed.
Bounded ordinary Session Claim/Skill dependencies use a frozen positive closure
and existing purge policy. Version3 / exact-source2 supports typed cross-Session source loss and the shared
retained-reference roster; old exact-source1 receipts explicitly refuse. It permits
clearing derived episode bodies while retaining original audit/unknown-budget links.
Unknown JSON/provenance/owner proof, canonical aliases and oversized closures refuse;
owner/retention successors remain pending. Independent acceptance is retained.
Unknown authority, mixed Team roots and unsupported owner/retention repairs refuse
or remain not-ready. Current metadata refresh preserves local policy and holds.
Global role dedication requires a bounded, identity-checked
read-only capability inventory of every other connectable DB; PUBLIC business
rights/SECURITY DEFINER access or an uninspectable DB abort before NOLOGIN.
Fence apply: exact reviewed dedicated role NOLOGIN, source CONNECT ACL revocation,
then terminate only the exact reviewed idle backends. Active/unknown peers abort.
Overlay: current closed target activation, fenced direct/SET ROLE writers, reviewed exact current
Relay privacy/scope facts and explicit retained metadata closure. Applies exact
Session/delivery/member/scope barriers and affected-installation holds; knowledge,
budgets, uncertain effects, canonical public bodies and archives are preserved.
Reports are atomic, private, versioned and never overwritten. Every retry uses a new
output directory with the SAME reviewed manifest; verify rechecks current barriers.
Fact/scope drift requires fresh review; source is never unfenced by this command.
No backups, credential resets, canonical Relay body changes, rollback, DSN switch or activation.
After target writes the target stays authoritative; forward repair only. Overlay
barrierApplied does not imply privacyCatchupReadyForReopen or business acceptance.
SIGINT/SIGTERM close dedicated sockets; open DB transaction rolls back. A committed
source credential fence remains restrictive and can be resumed with apply.
Exit 0=requested component operation verified, 2=refused, 130/143=interrupted.`
async function privateJson(path:string){
 const s=await lstat(path)
 if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0||s.size>8*1024*1024)throw Error('private_maintenance_file_required')
 return JSON.parse(await readFile(path,'utf8'))
}
export async function main(argv=process.argv.slice(2)):Promise<number>{
 if(argv.length===0||argv[0]==='--help'){process.stdout.write(maintenanceHelp+'\n');return 0}
 const [kind,command,...args]=argv,flags:Record<string,string>={}
 if(!['fence','overlay','cleanup','paged-cleanup'].includes(kind)||!['plan','apply','verify','resume'].includes(command)||command==='resume'&&!['cleanup','paged-cleanup'].includes(kind)){process.stderr.write('invalid_command\n');return 2}
 for(let i=0;i<args.length;i+=2){const key=args[i].slice(2),value=args[i+1];if(!args[i].startsWith('--')||!['config','manifest','overlay','output','roots'].includes(key)||flags[key]||!value||value.startsWith('--')){process.stderr.write('invalid_arguments\n');return 2}flags[key]=value}
 if(!flags.config||!flags.output||command==='plan'&&flags.manifest||command!=='plan'&&!flags.manifest||kind==='cleanup'&&command==='plan'&&!flags.overlay||flags.overlay&&(kind!=='cleanup'||command!=='plan')||kind==='paged-cleanup'&&command==='plan'&&!flags.roots||flags.roots&&(kind!=='paged-cleanup'||command!=='plan')){process.stderr.write('required_arguments_missing\n');return 2}
 let bundle:ReportBundle|undefined,interrupted:number|undefined
 const controller=new AbortController(),interrupt=(code:number)=>{interrupted=code;controller.abort();void cancelSourceMaintenance()}
 const sigint=()=>interrupt(130),sigterm=()=>interrupt(143)
 process.once('SIGINT',sigint);process.once('SIGTERM',sigterm)
 try{
  const raw=await privateJson(flags.config)
  if(!process.env.SHARED_MAINTENANCE_URL)throw Error('dedicated_maintenance_url_required')
  if(raw?.database?.url!==undefined)throw Error('url_in_config_forbidden')
  if(raw.tombstoneHmacKeys!==undefined)throw Error('keyring_in_config_forbidden')
  const cleanupKeys=['cleanup','paged-cleanup'].includes(kind)?JSON.parse(process.env.SHARED_MAINTENANCE_TOMBSTONE_KEYS??'null'):undefined
  const config={...raw,...(['cleanup','paged-cleanup'].includes(kind)?{tombstoneHmacKeys:cleanupKeys}:{}),database:{...raw.database,url:process.env.SHARED_MAINTENANCE_URL}},options={signal:controller.signal}
  if(kind==='paged-cleanup'&&command==='plan'){
   await planPagedCleanup(config,await privateJson(flags.roots),flags.output,options)
   if(interrupted)throw Error('maintenance_interrupted')
   process.stdout.write('maintenance_report_completed\n');return 0
  }
  const manifest=flags.manifest&&kind!=='paged-cleanup'?await privateJson(flags.manifest):undefined
  bundle=await ReportBundle.create(flags.output)
  const result=kind==='paged-cleanup'?(command==='verify'?await verifyPagedCleanup(config,flags.manifest,options):await applyPagedCleanup(config,flags.manifest,options)):kind==='cleanup'?(command==='plan'?await planForwardCleanup(config,await privateJson(flags.overlay),options):command==='verify'?await verifyForwardCleanup(config,manifest as ForwardCleanupManifest,options):await applyForwardCleanup(config,manifest as ForwardCleanupManifest,options)):kind==='fence'?(command==='plan'?await planSourceFence(config as SourceFenceConfig,options):command==='apply'?await applySourceFence(config,manifest as SourceFenceManifest,options):await verifySourceFence(config,manifest as SourceFenceManifest,options)):
    command==='plan'?await planPrivacyOverlay(config as PrivacyOverlayConfig,options):command==='apply'?await applyPrivacyOverlay(config,manifest as PrivacyOverlayManifest,options):await verifyPrivacyOverlay(config,manifest as PrivacyOverlayManifest,options)
  if(interrupted)throw Error('maintenance_interrupted')
  await bundle.write(command==='plan'?'maintenance-manifest.json':'maintenance-receipt.json',result)
  await bundle.write('run.json',{schemaVersion:1,kind:'memory-source-maintenance-run',operation:kind,command,activationAuthorized:false,backupCreated:false,rollbackSupported:false,completedAt:new Date().toISOString()})
  if(interrupted)throw Error('maintenance_interrupted')
  await bundle.finish();bundle=undefined;process.stdout.write('maintenance_report_completed\n');return 0
 }catch(e){process.stderr.write(interrupted?'interrupted\n':safeError(e)+'\n');return interrupted??2}
 finally{await bundle?.abort();process.removeListener('SIGINT',sigint);process.removeListener('SIGTERM',sigterm)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await main()
