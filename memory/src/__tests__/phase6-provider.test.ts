import { describe,expect,test } from 'vitest'
import { createHash } from 'node:crypto'
import { createGitHubReadCapability } from '../git-sync/github.js'
import { createGiteeReadCapability } from '../git-sync/gitee.js'
import { createGitTransport } from '../git-sync/transport.js'
import { gitWriteEndpoint } from '../git-sync/write-protocol.js'
import { gitTreeHash } from '../git-sync/git-objects.js'
import { describeGitExport } from '../git-sync/outbox-service.js'
import { buildExportBundle } from '../git-sync/attestation.js'
import { attestationFixture } from '../testing/phase6-attestation-fixture.js'
import { canonicalEd25519PublicKey } from '../git-sync/key-registry.js'

// Hand-authored public-protocol fixtures, no live API data. Sources checked 2026-09-02:
// docs.github.com/en/rest/{git/trees,git/blobs,git/commits,pulls/pulls}; API 2026-03-10.
// gitee.com/api/v5/swagger_doc.json version 5.4.92. Gitee lacks documented exact
// merge_commit_sha proof; fixtures MUST NOT silently invent production support.
// GitHub read permissions: Metadata/Contents/Pull requests read. Writes remain fixture-only.
const target={providerRepositoryId:'123',owner:'example',repository:'knowledge',branch:'main',private:true}
const commit='a'.repeat(40),tree='b'.repeat(40),exportId='00000000-0000-4000-8000-000000000001'
const path='.pocketctl/knowledge/manifest.yaml'
const payload=Buffer.from('sample\n'),blob=createHash('sha1').update(`blob ${payload.length}\0`).update(payload).digest('hex')
function fixture(provider:'github'|'gitee',responses:unknown[]) {
  const calls:{url:string;init:RequestInit}[]=[]
  const transport=createGitTransport({provider,token:'TEST_ONLY_TOKEN',maxResponseBytes:4096,
    fetch:async(url,init)=>{calls.push({url:String(url),init:init!});const value=responses.shift();return value instanceof Response?value:Response.json(value)}})
  const cap=(provider==='github'?createGitHubReadCapability:createGiteeReadCapability)({target,transport})
  return {cap,calls}
}
const signal=()=>new AbortController().signal
describe('fixed SaaS Git transports',()=>{
  test('rejects noncanonical DER and never trusts a PEM label as proof of Ed25519',()=>{
    const f=attestationFixture(),der=f.registry.verificationKey('test-1')!.publicKey.export({format:'der',type:'spki'})
    expect(canonicalEd25519PublicKey(der).asymmetricKeyType).toBe('ed25519')
    expect(()=>canonicalEd25519PublicKey(Buffer.concat([der,Buffer.from([0])]))).toThrow('git_attestation_key_invalid')
  })
  test('a cross-origin redirect is never followed and error bytes remain accounted',async()=>{
    const s=fixture('github',[new Response('redirect-body',{status:302,headers:{location:'https://attacker.invalid'}})])
    const result=await s.cap.request({operation:'poll',cursor:null},signal())
    expect(result).toMatchObject({status:302,receivedBytes:13})
    expect(s.calls).toHaveLength(1);expect(s.calls[0].url).toBe('https://api.github.com/repos/example/knowledge/pulls?state=all&base=main&per_page=100&page=1')
    expect(s.calls[0].init.redirect).toBe('error')
    expect(new Headers(s.calls[0].init.headers).get('X-GitHub-Api-Version')).toBe('2026-03-10')
  })
  test.each([401,403,409,429,500,503])('preserves status %s and measured error-body bytes',async status=>{
    const s=fixture('gitee',[new Response('bounded-error',{status,headers:{'retry-after':'2'}})])
    expect(await s.cap.request({operation:'poll',cursor:null},signal())).toMatchObject({status,receivedBytes:13,retryAfterMs:2000})
    expect(s.calls).toHaveLength(1)
  })
  test('malformed JSON reports consumed bytes without retaining its body',async()=>{
    const s=fixture('github',[new Response('secret malformed')])
    const e=await s.cap.request({operation:'commit',sha:commit},signal()).catch(e=>e)
    expect(e).toMatchObject({code:'provider_unverifiable',receivedBytes:16})
    expect(JSON.stringify(e)).not.toContain('secret malformed')
  })
  test('response byte overflow aborts stream with bounded measured byte metadata',async()=>{
    const s=fixture('github',[new Response('x'.repeat(5000))])
    await expect(s.cap.request({operation:'commit',sha:commit},signal())).rejects.toMatchObject({code:'response_limit',receivedBytes:5000})
  })
  test.each(['../evil','https://evil.invalid','main?token=x'])('refuses unsafe server target %s before network',owner=>{
    expect(()=>createGitHubReadCapability({target:{...target,owner},transport:()=>Promise.reject()})).toThrow('provider_target_invalid')
  })
})
describe('provider normalization and charged continuations',()=>{
  test.each(['github','gitee'] as const)('%s mixed ordinary/deleted fork poll page preserves the valid export candidate',async provider=>{
    const repo={id:123,full_name:'example/knowledge',private:true},base={ref:'main',repo}
    const s=fixture(provider,[[
      {number:1,head:{ref:'ordinary-feature',repo:{id:456,full_name:'contributor/knowledge',private:false}},base},
      {number:2,head:{ref:'deleted-feature',repo:null},base},
      {number:3,head:{ref:`pocketctl/export/${exportId}`,repo},base},
    ]])
    expect((await s.cap.request({operation:'poll',cursor:null},signal())).body).toEqual({providerRepositoryId:'123',branch:'main',changes:[{number:'3',exportId}],nextCursor:null})
    expect(s.calls).toHaveLength(1)
  })
  test.each(['github','gitee'] as const)('%s candidate fork/missing-repository/wrong-base/invalid-UUID proofs remain refused',async provider=>{
    const repo={id:123,full_name:'example/knowledge',private:true}
    for(const candidate of [
      {head:{ref:`pocketctl/export/${exportId}`,repo:{...repo,id:456}},base:{ref:'main',repo}},
      {head:{ref:`pocketctl/export/${exportId}`,repo:null},base:{ref:'main',repo}},
      {head:{ref:`pocketctl/export/${exportId}`,repo},base:{ref:'different',repo}},
      {head:{ref:'pocketctl/export/not-a-uuid',repo},base:{ref:'main',repo}},
    ]){
      const s=fixture(provider,[[{number:3,...candidate}]])
      await expect(s.cap.request({operation:'poll',cursor:null},signal())).rejects.toThrow()
      expect(s.calls).toHaveLength(1)
    }
  })
  test.each(['github','gitee'] as const)('%s accepts only a complete exact merged fixture and never substitutes merger identity',async provider=>{
    const repo={id:123,full_name:'example/knowledge',private:true}
    const s=fixture(provider,[{number:7,merged:true,merge_commit_sha:commit,head:{ref:`pocketctl/export/${exportId}`,repo},base:{ref:'main',repo},merged_by:{id:77},user:{id:99}}])
    expect((await s.cap.request({operation:'merge',number:'7'},signal())).body).toEqual({providerRepositoryId:'123',number:'7',baseBranch:'main',merged:true,mergeCommit:commit,exportId,actorId:null})
  })
  test('repository identity/visibility proof is a separate request and rejects an owner/repo reassignment',async()=>{
    const s=fixture('github',[{id:456,full_name:'example/knowledge',private:true}])
    await expect(s.cap.request({operation:'repository'},signal())).rejects.toMatchObject({code:'provider_target_mismatch'})
    expect(s.calls).toHaveLength(1);expect(s.calls[0].url).toBe('https://api.github.com/repos/example/knowledge')
  })
  test('GitHub normal unmerged result validates exact target/export and retains unknown authorship',async()=>{
    const s=fixture('github',[{number:7,merged:false,head:{ref:`pocketctl/export/${exportId}`,repo:{id:123,full_name:'example/knowledge',private:true}},base:{ref:'main',repo:{id:123,full_name:'example/knowledge',private:true}},user:{id:9},merged_by:{id:10}}])
    expect((await s.cap.request({operation:'merge',number:'7'},signal())).body).toEqual({providerRepositoryId:'123',number:'7',baseBranch:'main',merged:false,exportId,actorId:null})
  })
  test('Gitee merged response without documented exact commit proof fails closed',async()=>{
    const s=fixture('gitee',[{number:7,merged:true,head:`pocketctl/export/${exportId}`,base:'main'}])
    await expect(s.cap.request({operation:'merge',number:'7'},signal())).rejects.toMatchObject({code:'provider_unverifiable'})
  })
  test.each(['github','gitee'] as const)('%s root tree and blob consume separate single requests',async provider=>{
    const s=fixture(provider,[{sha:tree,truncated:false,tree:[{path,mode:'100644',type:'blob',sha:blob,size:payload.length}]},
      {sha:blob,encoding:'base64',size:payload.length,content:payload.toString('base64')}])
    const root=await s.cap.request({operation:'tree',commit,tree,cursor:null},signal())
    expect(root.body).toMatchObject({commit,tree,files:[],nextCursor:expect.any(String)});expect(s.calls).toHaveLength(1)
    const cursor=(root.body as any).nextCursor
    const leaf=await s.cap.request({operation:'tree',commit,tree,cursor},signal())
    expect(leaf.body).toEqual({commit,tree,files:[{path,mode:'100644',bytes:payload}],nextCursor:null});expect(s.calls).toHaveLength(2)
    await expect(s.cap.request({operation:'tree',commit,tree,cursor},signal())).rejects.toMatchObject({code:'provider_cursor_invalid'})
    expect(s.calls).toHaveLength(2)
  })
  test.each(['truncated','symlink','outside','wrong_blob'])('blocks %s tree proof',async variant=>{
    const s=fixture('github',[{sha:tree,truncated:variant==='truncated',tree:[{path:variant==='outside'?'../bad':path,mode:variant==='symlink'?'120000':'100644',type:'blob',sha:blob,size:payload.length}]},
      {sha:blob,encoding:'base64',size:payload.length,content:Buffer.from('forged\n').toString('base64')}])
    const run=async()=>{const root=await s.cap.request({operation:'tree',commit,tree,cursor:null},signal());await s.cap.request({operation:'tree',commit,tree,cursor:(root.body as any).nextCursor},signal())}
    await expect(run()).rejects.toMatchObject({code:'provider_unverifiable'})
  })
  test('poll does not follow provider Link URLs and bounds its page numbers',async()=>{
    const s=fixture('github',[new Response('[]',{headers:{link:'<https://attacker.invalid>; rel="next"'}})])
    expect((await s.cap.request({operation:'poll',cursor:null},signal())).body).toMatchObject({changes:[],nextCursor:null})
    await expect(s.cap.request({operation:'poll',cursor:'129'},signal())).rejects.toMatchObject({code:'provider_cursor_invalid'})
    expect(s.calls).toHaveLength(1)
  })
})
describe('write protocol contract (test capability only)',()=>{
  test('Git object hashing matches the canonical empty-tree object',()=>{
    expect(gitTreeHash([])).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904')
  })
  test('Gitee uses Contents expected SHA and a unique export branch; never a writable tree API',()=>{
    expect(gitWriteEndpoint('gitee',target,{action:'write_file',path,branch:`pocketctl/export/${exportId}`,bytes:payload,expectedBlob:blob,message:'export'}))
      .toMatchObject({method:'PUT',encoding:'form',segments:['repos','example','knowledge','contents','.pocketctl','knowledge','manifest.yaml'],body:{sha:blob,content:'c2FtcGxlCg=='}})
    expect(()=>gitWriteEndpoint('gitee',target,{action:'write_file',path,branch:'main',bytes:payload,expectedBlob:blob,message:'export'})).toThrow('provider_target_invalid')
  })
  test('readable PR description contains version/hash/export and Evidence refs but no source excerpts',()=>{
    const f=attestationFixture(),bundle=buildExportBundle(f.context,f.assets,f.registry),body=describeGitExport(bundle)
    expect(body).toContain(bundle.exportId);expect(body).toContain('Reason:');expect(body).toContain('Old version:');expect(body).toContain('New version:')
    expect(body).toContain(f.assets[0].asset.baseVersionId);expect(body).toContain(f.assets[0].contentHash)
    expect(body).toContain('Evidence:');expect(body).not.toContain('/private/')
  })
})
