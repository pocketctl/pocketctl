import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp,readFile,writeFile,readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve,join } from 'node:path'
import { expect,test } from 'vitest'
const run=promisify(execFile),cli=resolve('src/migrations/shared-source/cli.ts'),tsx=resolve('node_modules/.bin/tsx')
test('unknown command and missing identity fail without opening application services or leaking env',async()=>{
 const env={...process.env,SHARED_SOURCE_MEMORY_URL:'postgres://secret:secret-password@invalid-host/db',MEMORY_DATABASE_URL:'postgres://unrelated:secret-password@host/db'}
 for(const args of [['apply'],['inventory','--output','/tmp/never-write'],['map-plan','--identity','/never-open','--output','/never-write','--migration-id','test','--code-sha','a'.repeat(40),'--snapshot-id','test','--legacy-in-place','apply']]){
  try{await run(tsx,[cli,...args],{env});throw Error('unexpected success')}
  catch(e:any){expect(e.code).toBe(2);expect(e.stderr).not.toContain('secret-password');expect(e.stderr).not.toContain('invalid-host')}
 }
})
test('capacity input is allowlisted, versioned, and incomplete measurements are not-ready',async()=>{
 const root=await mkdtemp(join(tmpdir(),'shared-source-cli-')),input=join(root,'input.json'),out=join(root,'report')
 await writeFile(input,JSON.stringify({freeBytes:'9007199254740993',password:'DO-NOT-EXPORT'}))
 await expect(run(tsx,[cli,'capacity-plan','--input',input,'--output',out,'--migration-id','test-1','--code-sha','a'.repeat(40)])).rejects.toMatchObject({code:3})
 const report=await readFile(join(out,'capacity.json'),'utf8')
 expect(report).not.toContain('DO-NOT-EXPORT')
 expect(JSON.parse(report)).toMatchObject({schemaVersion:2,ready:false,status:'not-ready',migrationAuthorized:false})
 expect(await readdir(out)).toContain('run.json')
})
