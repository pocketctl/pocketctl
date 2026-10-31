import {expect,test} from 'vitest'
import {createGitHubReadCapability} from '../git-sync/github.js'
const sha='a'.repeat(40),head='b'.repeat(40),tree='c'.repeat(40),exportId='00000000-0000-4000-8000-000000000001'
const repo={id:123,full_name:'example/knowledge',private:true}
async function proof(change:(body:any,commit:any)=>void=()=>{}) {
  const body={sha:head,author:{id:1234},committer:{id:1234},commit:{tree:{sha:tree},author:{email:'verified@example.test'},committer:{email:'verified@example.test'},verification:{verified:true,reason:'valid',signature:'fixture-signed',payload:`tree ${tree}\nfixture`}}}
  const commit={sha,tree:{sha:tree},parents:[{sha:head}]};change(body,commit)
  const responses=[{number:7,merged:true,merge_commit_sha:sha,head:{ref:`pocketctl/export/${exportId}`,sha:head,repo},base:{ref:'main',repo},user:{id:9999},merged_by:{id:8888}},commit,body]
  const cap=createGitHubReadCapability({target:{providerRepositoryId:'123',owner:'example',repository:'knowledge',branch:'main',private:true},transport:async()=>({status:200,body:responses.shift()})})
  expect((await cap.request({operation:'merge',number:'7'},new AbortController().signal)).body).toMatchObject({actorId:null,headCommit:head})
  await cap.request({operation:'commit',sha},new AbortController().signal)
  return (await cap.request({operation:'commit',sha:head,proofFor:{mergeCommit:sha,tree}},new AbortController().signal)).body
}
test('verified same-author signature on the exact merged tree identifies its author, never PR opener or merger',async()=>{
  expect(await proof()).toEqual({sha:head,tree,actorId:'1234'})
})
test.each(['unsigned','different_author','different_email','different_tree','not_parent','wrong_payload','missing_signature'])('incomplete authorship proof remains unknown: %s',async reason=>{
  expect(await proof((b,c)=>{
    if(reason==='unsigned')b.commit.verification.verified=false
    if(reason==='different_author')b.author.id=1111
    if(reason==='different_email')b.commit.author.email='spoofed@example.test'
    if(reason==='different_tree')b.commit.tree.sha='d'.repeat(40)
    if(reason==='not_parent')c.parents=[]
    if(reason==='wrong_payload')b.commit.verification.payload='unrelated'
    if(reason==='missing_signature')b.commit.verification.signature=null
  })).toMatchObject({actorId:null})
})
