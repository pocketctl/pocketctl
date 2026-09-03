import { createHash,randomUUID } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { redactSecrets } from '../episodes/content-policy.js'
import { createGitExportService } from './export-service.js'
import { GitReadError,type GitReadResponse } from './provider.js'
import { gitObjectHash,gitTreeHash,gitCommitHash,type GitTreeEntry } from './git-objects.js'
import type { GitFixtureWriteCapability,GitWriteRequest } from './write-protocol.js'
import type { GitRequestOperation } from './request-executor.js'
import type { ExportBundle } from './types.js'

const sha=z.string().regex(/^[a-f0-9]{40}$/)
const parse=<T>(schema:z.ZodType<T>,value:unknown)=>{const parsed=schema.safeParse(value);if(!parsed.success)throw new GitReadError('provider_unverifiable');return parsed.data}
type Proof={sha?:string;tree?:string;number?:string}
interface OutboxRow{outbox_id:string;operation:string;created_at:Date;state:string}
interface StepRow{state:string;remote_sha:string|null;remote_tree:string|null;remote_number:string|null;expected_head:string|null;expected_blob:string|null;expected_tree:string|null;expected_commit:string|null;expected_content_blob:string|null}
/** No source excerpts, author email, credentials, internal locators or free text
 * supplied by a caller. Old asset version is unknown until platform proof exists. */
export function describeGitExport(bundle:ExportBundle):string {
  const lines=[`PocketCtl Memory export ${bundle.exportId}`,'','Reason: Publish reviewed Memory assets from the authorized signed snapshot.',
    `Old version: repository commit ${bundle.baseCommit}`,`Old hash: ${bundle.baseCommit}`]
  for(const snapshot of bundle.assets){
    lines.push('',`Asset: ${snapshot.asset.key.kind} ${snapshot.asset.key.id}`,`New version: ${snapshot.asset.baseVersionId}`,`New hash: ${snapshot.contentHash}`)
    lines.push(...snapshot.asset.immutable.evidence.map(e=>`Evidence: ${e.evidenceId} version ${e.versionId} hash ${e.hash}`))
  }
  lines.push('',`Export ID: ${bundle.exportId}`)
  const body=lines.join('\n');if(Buffer.byteLength(body)>65536)throw new GitReadError('response_limit');return body
}
export function assertExportContentSafe(bundle:ExportBundle){
  if(!bundle.publishable||bundle.purpose!=='external_export')throw new GitReadError('export_not_publishable')
  for(const file of bundle.files){const text=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes)
    if(redactSecrets(text)!==text)throw new GitReadError('secret_detected')}
}
/** Called only inside the existing worker dispatcher gate, using its exported
 * reservation executor and current fence callback. This module has no transport
 * constructor; production cannot obtain a write capability from its config. */
export async function dispatchGitOutbox(input:{
  service:ReturnType<typeof createGitExportService>;grant:Parameters<ReturnType<typeof createGitExportService>['loadRegisteredBase']>[0]
  subject:{installationId:string;connectionId:string;exportId:string;expectedGeneration:string};runId:string;pool:pg.Pool
  capability:GitFixtureWriteCapability;signal:AbortSignal
  withRun<T>(fn:(client:pg.PoolClient)=>Promise<T>):Promise<T>
  fence(client:pg.PoolClient):Promise<void>
  execute(operation:GitRequestOperation,perform:(signal:AbortSignal)=>Promise<GitReadResponse>,success?:readonly number[]):Promise<GitReadResponse>
}) {
  const {subject:s,capability:cap}=input
  if(cap.kind!=='fixture')throw new GitReadError('write_not_authorized')
  let bundle:ExportBundle|undefined
  const outboxes=await input.service.withRegisteredBase(input.grant,s,async context=>{
    assertExportContentSafe(context.base);bundle=context.base
    await input.fence(context.client)
    const descriptionHash=createHash('sha256').update(describeGitExport(context.base)).digest('hex')
    const rows:OutboxRow[]=[]
    for(const operation of ['commit','branch','pull_request']){
      await context.client.query(`INSERT INTO memory_git_outbox(outbox_id,installation_id,connection_id,run_id,export_id,generation,operation,expected_head,remote_branch,description_hash,target_owner,target_repository,target_private)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(installation_id,connection_id,export_id,operation) DO NOTHING`,
        [randomUUID(),s.installationId,s.connectionId,input.runId,s.exportId,s.expectedGeneration,operation,context.base.baseCommit,`pocketctl/export/${s.exportId}`,descriptionHash,cap.target.owner,cap.target.repository,cap.target.private])
      const row=(await context.client.query<OutboxRow>(`SELECT outbox_id,operation,created_at,state FROM memory_git_outbox
        WHERE installation_id=$1 AND connection_id=$2 AND export_id=$3 AND operation=$4 AND run_id=$5`,[s.installationId,s.connectionId,s.exportId,operation,input.runId])).rows[0]
      if(!row||['cancelled','invalidated','dead'].includes(row.state))throw new GitReadError('run_terminal');rows.push(row)
    }
    return rows
  })
  const base=bundle!,branch=`pocketctl/export/${base.exportId}`,description=describeGitExport(base)
  const date=new Date(Math.floor(outboxes[0].created_at.getTime()/1000)*1000).toISOString().replace('.000Z','Z'),message=`PocketCtl export ${base.exportId}`
  const call=async(request:GitWriteRequest,operation:GitRequestOperation='reconcile',success:readonly number[]=[200])=>(await input.execute(operation,signal=>cap.request(request,signal),success))
  const fixed=cap.target
  function assertRepo(raw:unknown){const r=parse(z.object({id:z.union([z.string(),z.number().int().safe()]),full_name:z.string(),private:z.boolean()}),raw)
    if(String(r.id)!==fixed.providerRepositoryId||r.full_name!==`${fixed.owner}/${fixed.repository}`||r.private!==fixed.private)throw new GitReadError('provider_target_mismatch')}
  assertRepo((await call({action:'repository'})).body)
  function readCommit(raw:unknown,expected:string){
    const value=cap.provider==='github'?parse(z.object({sha,tree:z.object({sha}),parents:z.array(z.object({sha})).max(16),message:z.string()}),raw)
      :(()=>{const r=parse(z.object({sha,commit:z.object({tree:z.object({sha}),message:z.string()}),parents:z.array(z.object({sha})).max(16)}),raw);return {...r,...r.commit}})()
    if(value.sha!==expected)throw new GitReadError('provider_unverifiable');return value
  }
  async function commitAt(commit:string){return readCommit((await call({action:'commit',sha:commit})).body,commit)}
  async function readTree(tree:string):Promise<GitTreeEntry[]>{
    const value=parse(z.object({sha,truncated:z.boolean().optional(),tree:z.array(z.object({path:z.string(),mode:z.string(),sha,type:z.string(),size:z.number().optional()})).max(4096)}),(await call({action:'tree',sha:tree})).body)
    if(value.sha!==tree||value.truncated||gitTreeHash(value.tree)!==tree)throw new GitReadError('provider_unverifiable')
    return value.tree.filter(e=>e.type!=='tree')
  }
  async function head(name:string):Promise<string|null>{
    const result=await call({action:'branch',branch:name},'reconcile',[200,404]);if(result.status===404)return null
    if(cap.provider==='github'){const v=parse(z.object({ref:z.string(),object:z.object({sha})}),result.body);if(v.ref!==`refs/heads/${name}`)throw new GitReadError('provider_unverifiable');return v.object.sha}
    const v=parse(z.object({name:z.string(),commit:z.object({sha})}),result.body);if(v.name!==name)throw new GitReadError('provider_unverifiable');return v.commit.sha
  }
  const originalCommit=await commitAt(base.baseCommit),original=await readTree(originalCommit.tree.sha),desired=new Map(original.map(e=>[e.path,e]))
  for(const file of base.files)desired.set(file.path,{path:file.path,mode:'100644',sha:gitObjectHash('blob',file.bytes),type:'blob',size:file.bytes.length})
  const desiredTree=gitTreeHash([...desired.values()]),desiredCommit=gitCommitHash(desiredTree,base.baseCommit,message,date)
  await input.withRun(async client=>{await client.query(`UPDATE memory_git_outbox SET expected_tree=$4,expected_commit=COALESCE($5,expected_commit) WHERE installation_id=$1 AND connection_id=$2 AND export_id=$3`,[s.installationId,s.connectionId,s.exportId,desiredTree,cap.provider==='github'?desiredCommit:null])})
  async function step(operation:'commit'|'branch'|'pull_request',index:number,kind:'tree'|'commit'|'branch'|'file'|'pull_request',
    expected:{head?:string;blob?:string;contentBlob?:string;path?:string;tree?:string;commit?:string},query:(saved:StepRow)=>Promise<Proof|null>,mutate:()=>Promise<Proof>):Promise<Proof>{
    const box=outboxes.find(b=>b.operation===operation)!
    const row=await input.withRun(async client=>{
      await client.query(`INSERT INTO memory_git_outbox_steps(installation_id,connection_id,outbox_id,step,operation,state,path,expected_head,expected_blob,expected_tree,expected_commit,expected_content_blob)
        VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,[s.installationId,s.connectionId,box.outbox_id,index,kind,expected.path??null,expected.head??null,expected.blob??null,expected.tree??null,expected.commit??null,expected.contentBlob??null])
      return (await client.query<StepRow>(`SELECT state,remote_sha,remote_tree,remote_number,expected_head,expected_blob,expected_tree,expected_commit,expected_content_blob FROM memory_git_outbox_steps
        WHERE installation_id=$1 AND connection_id=$2 AND outbox_id=$3 AND step=$4 FOR UPDATE`,[s.installationId,s.connectionId,box.outbox_id,index])).rows[0]
    })
    if(row.expected_head!==(expected.head??null)||row.expected_blob!==(expected.blob??null)||row.expected_tree!==(expected.tree??null)||row.expected_commit!==(expected.commit??null))throw new GitReadError('provider_conflict')
    if(row.expected_content_blob!==null&&row.expected_content_blob!==(expected.contentBlob??null))throw new GitReadError('provider_conflict')
    if(row.state==='completed')return {sha:row.remote_sha??undefined,tree:row.remote_tree??undefined,number:row.remote_number??undefined}
    try {
      let proof=await query(row)
      if(!proof){
        // Full current source/key/export revalidation precedes every mutation;
        // no transaction or source lock survives into the HTTP request.
        assertExportContentSafe(await input.service.loadRegisteredBase(input.grant,s))
        await input.withRun(async client=>{await client.query(`UPDATE memory_git_outbox_steps SET state='dispatching' WHERE outbox_id=$1 AND step=$2`,[box.outbox_id,index])
          await client.query("UPDATE memory_git_outbox SET state='dispatching' WHERE outbox_id=$1",[box.outbox_id])})
        proof=await mutate()
      }
      await input.withRun(async client=>{await client.query(`UPDATE memory_git_outbox_steps SET state='completed',remote_sha=$3,remote_tree=$4,remote_number=$5,updated_at=NOW()
        WHERE outbox_id=$1 AND step=$2`,[box.outbox_id,index,proof!.sha??null,proof!.tree??null,proof!.number??null])})
      return proof
    }catch(error){
      // Remote success may have occurred even if the local fence has expired.
      // Recording uncertainty is metadata only; later retries may only query
      // until current authority permits another mutation.
      await input.pool.query(`UPDATE memory_git_outbox_steps SET state='reconciling',updated_at=NOW() WHERE outbox_id=$1 AND step=$2 AND state<>'completed'`,[box.outbox_id,index])
      await input.pool.query("UPDATE memory_git_outbox SET state='reconciling' WHERE outbox_id=$1 AND state NOT IN('cancelled','invalidated','dead')",[box.outbox_id])
      throw error
    }
  }
  let preparedCommit:string
  if(cap.provider==='github'){
    const existing=await head(branch);if(existing&&existing!==desiredCommit)throw new GitReadError('provider_conflict')
    await step('commit',0,'tree',{tree:desiredTree},async()=>{const r=await call({action:'tree',sha:desiredTree},'reconcile',[200,404]);if(r.status===404)return null
      const v=parse(z.object({sha}),r.body);if(v.sha!==desiredTree)throw new GitReadError('provider_unverifiable');await readTree(desiredTree);return {tree:desiredTree}},async()=>{
      const v=parse(z.object({sha}),(await call({action:'create_tree',baseTree:originalCommit.tree.sha,files:base.files},'write_tree',[201])).body)
      if(v.sha!==desiredTree)throw new GitReadError('provider_unverifiable');return {tree:desiredTree}})
    const verifyPrepared=(raw:unknown)=>{const v=readCommit(raw,desiredCommit)
      if(v.tree.sha!==desiredTree||v.parents.length!==1||v.parents[0].sha!==base.baseCommit||v.message.trimEnd()!==message)throw new GitReadError('provider_unverifiable');return {sha:desiredCommit,tree:desiredTree}}
    await step('commit',1,'commit',{head:base.baseCommit,commit:desiredCommit,tree:desiredTree},async()=>{const r=await call({action:'commit',sha:desiredCommit},'reconcile',[200,404]);return r.status===404?null:verifyPrepared(r.body)},async()=>{
      return verifyPrepared((await call({action:'create_commit',tree:desiredTree,parent:base.baseCommit,message,date},'write_commit',[201])).body)})
    await step('branch',0,'branch',{head:desiredCommit,commit:desiredCommit,tree:desiredTree},async()=>{const current=await head(branch);if(current&&current!==desiredCommit)throw new GitReadError('provider_conflict');return current?{sha:current}:null},async()=>{
      await call({action:'create_branch',branch,sha:desiredCommit},'write_branch',[201]);if(await head(branch)!==desiredCommit)throw new GitReadError('provider_conflict');return {sha:desiredCommit}})
    preparedCommit=desiredCommit
  } else {
    await step('branch',0,'branch',{head:base.baseCommit,commit:base.baseCommit,tree:originalCommit.tree.sha},async()=>{const current=await head(branch);if(current&&current!==base.baseCommit)throw new GitReadError('provider_conflict');return current?{sha:current}:null},async()=>{
      await call({action:'create_branch',branch,sha:base.baseCommit},'write_branch',[201]);if(await head(branch)!==base.baseCommit)throw new GitReadError('provider_conflict');return {sha:base.baseCommit}})
    let parent=base.baseCommit;const evolving=new Map(original.map(e=>[e.path,e]))
    for(const [index,file] of base.files.entries()){
      const expectedHead=parent,old=evolving.get(file.path),blob=gitObjectHash('blob',file.bytes)
      evolving.set(file.path,{path:file.path,mode:'100644',type:'blob',sha:blob,size:file.bytes.length});const tree=gitTreeHash([...evolving.values()])
      const verifyFile=async(current:string)=>{const commit=await commitAt(current)
        if(commit.parents.length!==1||commit.parents[0].sha!==expectedHead||commit.tree.sha!==tree)throw new GitReadError('provider_conflict')
        await readTree(tree);return {sha:current,tree}}
      const result=await step('commit',index,'file',{head:expectedHead,blob:old?.sha,contentBlob:blob,path:file.path,tree},async row=>{
        const current=await head(branch);if(current===expectedHead)return null
        if(!current||!['dispatching','reconciling'].includes(row.state))throw new GitReadError('provider_conflict')
        return verifyFile(current)
      },async()=>{
        if(await head(branch)!==expectedHead)throw new GitReadError('provider_conflict')
        const v=parse(z.object({commit:z.object({sha}),content:z.object({sha})}),(await call({action:'write_file',path:file.path,branch,bytes:file.bytes,expectedBlob:old?.sha??null,message},'write_file',[200,201])).body)
        if(v.content.sha!==blob||await head(branch)!==v.commit.sha)throw new GitReadError('provider_conflict');return verifyFile(v.commit.sha)
      });parent=result.sha!
    }
    preparedCommit=parent
  }
  // Both APIs lack expected-old-head atomic CAS. Immutable branch creation and
  // exact head/tree checks refuse concurrent changes; no force/update/merge API.
  if(await head(branch)!==preparedCommit)throw new GitReadError('provider_conflict')
  const final=await commitAt(preparedCommit);if(final.tree.sha!==desiredTree)throw new GitReadError('provider_conflict');await readTree(desiredTree)
  await input.withRun(async client=>{await client.query(`UPDATE memory_git_outbox SET expected_commit=$4 WHERE installation_id=$1 AND connection_id=$2 AND export_id=$3`,[s.installationId,s.connectionId,s.exportId,preparedCommit])})
  const prSchema=z.object({number:z.number().int().positive(),body:z.string(),draft:z.boolean(),head:z.object({ref:z.string(),sha,repo:z.unknown()}),base:z.object({ref:z.string(),repo:z.unknown()})})
  function checkPull(raw:unknown):Proof {const p=parse(prSchema,raw);assertRepo(p.head.repo);assertRepo(p.base.repo)
    if(p.head.ref!==branch||p.head.sha!==preparedCommit||p.base.ref!==fixed.branch||p.body!==description||!p.draft)throw new GitReadError('provider_conflict');return {number:String(p.number),sha:preparedCommit,tree:desiredTree}}
  const pull=await step('pull_request',0,'pull_request',{head:preparedCommit,commit:preparedCommit,tree:desiredTree},async()=>{
    let found:Proof|null=null
    for(let page=1;page<=128;page++){
      const list=parse(z.array(z.unknown()).max(100),(await call({action:'pulls',branch,page})).body)
      for(const raw of list){const p=parse(prSchema,raw);if(p.head.ref!==branch||p.base.ref!==fixed.branch)continue
        if(found)throw new GitReadError('provider_conflict');found=checkPull(raw)}
      if(list.length<100)return found
    }throw new GitReadError('request_budget_exhausted')
  },async()=>{
    if(await head(branch)!==preparedCommit)throw new GitReadError('provider_conflict')
    return checkPull((await call({action:'create_pull',branch,title:`Memory export ${base.exportId}`,body:description},'write_pull_request',[201])).body)
  })
  await input.withRun(async client=>{await client.query(`UPDATE memory_git_outbox SET state='completed',remote_commit=$4,expected_tree=$5,remote_pr_id=$6,updated_at=NOW()
    WHERE installation_id=$1 AND connection_id=$2 AND export_id=$3`,[s.installationId,s.connectionId,s.exportId,preparedCommit,desiredTree,pull.number])})
  return {branch,commit:preparedCommit,tree:desiredTree,pullNumber:pull.number!}
}
