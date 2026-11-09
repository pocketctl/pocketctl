#!/usr/bin/env node
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readdir,readFile,writeFile,mkdtemp,mkdir,copyFile,rm} from 'node:fs/promises'
import {join,dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {tmpdir} from 'node:os'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),pkg=join(root,'shared/session-source'),check=process.argv.includes('--check')
execFileSync(join(root,'memory/node_modules/.bin/tsc'),['-p',join(pkg,'tsconfig.json'),'--typeRoots',join(root,'memory/node_modules/@types')],{stdio:'inherit'})
const hash=createHash('sha256')
async function walk(dir){for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(dir,entry.name);if(entry.isDirectory())await walk(path);else hash.update(path.slice(pkg.length)).update(await readFile(path))}}
await walk(join(pkg,'src'));await writeFile(join(pkg,'dist/source-manifest.json'),JSON.stringify({schemaVersion:1,sourceSha256:hash.digest('hex')})+'\n')
const scratch=await mkdtemp(join(tmpdir(),'pocketctl-session-source-pack-'))
try{
 const result=JSON.parse(execFileSync('npm',['pack','--json','--ignore-scripts','--pack-destination',scratch],{cwd:pkg,encoding:'utf8'}))[0]
 const packed=join(scratch,result.filename)
 for(const service of ['memory','relay']){
  const dir=join(root,service,'packages'),target=join(dir,'session-source-0.1.0.tgz')
  if(check){if(!(await readFile(packed)).equals(await readFile(target)))throw Error('session-source package is stale: '+service)}
  else{await mkdir(dir,{recursive:true});await copyFile(packed,target)}
  const lockPath=join(root,service,'package-lock.json'),lockText=await readFile(lockPath,'utf8'),lock=JSON.parse(lockText)
  const entry=lock.packages['node_modules/@pocketctl/session-source']
  if(entry){
   if(check && entry.integrity!==result.integrity)throw Error('session-source lock integrity is stale: '+service)
   if(!check && entry.integrity!==result.integrity){
    const old='\"integrity\": '+JSON.stringify(entry.integrity),updated='\"integrity\": '+JSON.stringify(result.integrity)
    const at=lockText.indexOf('\"node_modules/@pocketctl/session-source\"'),before=lockText.slice(0,at),after=lockText.slice(at)
    await writeFile(lockPath,before+after.replace(old,updated))
   }
  }else if(check)throw Error('session-source dependency is not installed: '+service)

 }
 process.stdout.write(check?'Shared source packages match source\n':'Shared source package built for Memory and Relay\n')
}finally{await rm(scratch,{recursive:true,force:true})}
