import {readFile,stat} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {planPersonalDirectPrivacy,applyPersonalDirectPrivacy,verifyPersonalDirectPrivacy,type PersonalDirectPrivacyConfig} from './personal-direct-privacy.js'
import {cancelSourceMaintenance} from './source-maintenance-common.js'
import {ReportBundle} from '../shared-source/report.js'
import {safeError} from '../shared-source/database.js'
const help=`Finite personal direct-launch privacy (closed copied target only).
  plan --input FILE --output NEW_DIR
  apply|verify --input FILE --manifest FILE --output NEW_DIR
Input: {database:{database,databaseOid,role,serverAddress,serverPort},scope:{personalInstallationId,organizationInstallationId},installationIds,units}.
Dedicated URL: SHARED_FORWARD_TARGET_URL; no URL is serialized into receipts.
Audits existing FK/explicit JSON metadata in bounded pages; preserves ordinary
unknown source cells, original IDs, accepted independent capsules and budgets.
Missing current personal Sessions receive a restriction, not a deletion proof.
Unexpected derived dependencies or control drift refuse. No global authority,
mode/DSN switch, activation, backup, rollback, body export or model calls.`
export async function main(argv=process.argv.slice(2)){
 if(!argv.length||argv[0]==='--help'){process.stdout.write(help+'\n');return 0}
 const [command,...args]=argv,flags:Record<string,string>={}
 if(!['plan','apply','verify'].includes(command)){process.stderr.write('invalid_arguments\n');return 2}
 for(let n=0;n<args.length;n+=2){const key=args[n],value=args[n+1];if(!['--input','--manifest','--output'].includes(key)||!value||value.startsWith('--')||flags[key]){process.stderr.write('invalid_arguments\n');return 2}flags[key]=value}
 if(!flags['--input']||!flags['--output']||command==='plan'&&flags['--manifest']||command!=='plan'&&!flags['--manifest']){process.stderr.write('required_arguments_missing\n');return 2}
 const controller=new AbortController();let interrupted:number|undefined,bundle:ReportBundle|undefined
 const interrupt=(code:number)=>{interrupted=code;controller.abort();void cancelSourceMaintenance()},sigint=()=>interrupt(130),sigterm=()=>interrupt(143)
 process.once('SIGINT',sigint);process.once('SIGTERM',sigterm)
 try{
  for(const path of [flags['--input'],flags['--manifest']].filter(Boolean))if((await stat(path)).size>8*1024*1024)throw Error('input_file_limit')
  const input=JSON.parse(await readFile(flags['--input'],'utf8')),url=process.env.SHARED_FORWARD_TARGET_URL
  if(!url)throw Error('dedicated_forward_url_required')
  const config:PersonalDirectPrivacyConfig={...input,database:{url,expected:input.database}}
  bundle=await ReportBundle.create(flags['--output']);const options={signal:controller.signal}
  const value=command==='plan'?await planPersonalDirectPrivacy(config,options):await (command==='apply'?applyPersonalDirectPrivacy:verifyPersonalDirectPrivacy)(config,JSON.parse(await readFile(flags['--manifest'],'utf8')),options)
  if(interrupted)throw Error('interrupted')
  await bundle.write(command==='plan'?'personal-direct-privacy-plan.json':'personal-direct-privacy-verification.json',value);await bundle.finish();bundle=undefined
  process.stdout.write('finite_personal_privacy_'+command+'_completed\n');return 0
 }catch(e){process.stderr.write(interrupted?'interrupted\n':safeError(e)+'\n');return interrupted??2}finally{await bundle?.abort();process.removeListener('SIGINT',sigint);process.removeListener('SIGTERM',sigterm)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await main()
