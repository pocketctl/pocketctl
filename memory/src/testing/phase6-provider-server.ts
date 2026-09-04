import { gitTreeHash,gitObjectHash,gitCommitHash,type GitTreeEntry } from '../git-sync/git-objects.js'
import type { GitWriteEndpoint } from '../git-sync/write-protocol.js'
import { GitReadError } from '../git-sync/provider.js'
/** TEST ONLY stateful HTTP protocol stub: effects survive simulated lost responses. */
export function fixtureGitServer(provider:'github'|'gitee') {
  const trees=new Map<string,GitTreeEntry[]>([[gitTreeHash([]),[]]])
  const commits=new Map<string,{sha:string;tree:{sha:string};parents:{sha:string}[];message:string}>([['a'.repeat(40),{sha:'a'.repeat(40),tree:{sha:gitTreeHash([])},parents:[],message:'base'}]])
  const branches=new Map([['main','a'.repeat(40)]]),pulls:any[]=[],calls:GitWriteEndpoint[]=[]
  let failAction:string|undefined,failStatus:number|undefined,afterMutation:(()=>void|Promise<void>)|undefined
  const repo={id:123,full_name:'example/knowledge',private:true}
  return {trees,commits,branches,pulls,calls,loseNext:(action:string)=>{failAction=action},statusNext:(status:number)=>{failStatus=status},afterMutation:(fn:()=>void|Promise<void>)=>{afterMutation=fn},
    async request(e:GitWriteEndpoint){
      calls.push(e);const result=(status:number,body?:unknown)=>({status,body,receivedBytes:body?Buffer.byteLength(JSON.stringify(body)):0})
      if(failStatus){const status=failStatus;failStatus=undefined;return result(status)}
      const tail=e.segments.slice(3),body=e.body as any
      let response:any,action=''
      if(!tail.length)return result(200,repo)
      if(e.method==='GET'){
        if(tail[0]==='git'&&tail[1]==='trees')return trees.has(tail[2])?result(200,{sha:tail[2],truncated:false,tree:trees.get(tail[2])}):result(404)
        if(tail[0]==='commits'||tail[0]==='git'&&tail[1]==='commits'){
          const value=commits.get(tail.at(-1)!);return value?result(200,provider==='github'?value:{sha:value.sha,commit:{tree:value.tree,message:value.message},parents:value.parents}):result(404)}
        if(tail[0]==='branches'||tail[0]==='git'&&tail[1]==='ref'){
          const name=tail.at(-1)!,head=branches.get(name);return head?result(200,provider==='github'?{ref:`refs/heads/${name}`,object:{sha:head}}:{name,commit:{sha:head}}):result(404)}
        if(tail[0]==='pulls')return result(200,pulls.filter(p=>`${repo.full_name.split('/')[0]}:${p.head.ref}`===e.query?.head))
        return result(404)
      }
      if(tail[0]==='git'&&tail[1]==='trees'){
        action='tree';const base=trees.get(body.base_tree)!;const entries=new Map(base.map(v=>[v.path,v]))
        for(const f of body.tree){const bytes=Buffer.from(f.content);entries.set(f.path,{path:f.path,mode:f.mode,type:'blob',sha:gitObjectHash('blob',bytes),size:bytes.length})}
        const values=[...entries.values()],sha=gitTreeHash(values);trees.set(sha,values);response={sha}
      }else if(tail[0]==='git'&&tail[1]==='commits'){
        action='commit';const sha=gitCommitHash(body.tree,body.parents[0],body.message,body.author.date)
        const value={sha,tree:{sha:body.tree},parents:body.parents.map((sha:string)=>({sha})),message:body.message};commits.set(sha,value);response=value
      }else if(tail[0]==='branches'||tail[0]==='git'&&tail[1]==='refs'){
        action='branch';const name=provider==='github'?body.ref.slice(11):body.branch_name,sha=body.sha??body.refs
        if(branches.has(name))return result(409);branches.set(name,sha);response=provider==='github'?{ref:`refs/heads/${name}`,object:{sha}}:{name,commit:{sha}}
      }else if(tail[0]==='contents'){
        action='file';const path=tail.slice(1).join('/'),parent=branches.get(body.branch)!,tree=commits.get(parent)!.tree.sha,entries=new Map(trees.get(tree)!.map(v=>[v.path,v]))
        const previous=entries.get(path);if((body.sha??null)!==(previous?.sha??null))return result(409)
        const bytes=Buffer.from(body.content,'base64'),blob=gitObjectHash('blob',bytes);entries.set(path,{path,sha:blob,mode:'100644',type:'blob',size:bytes.length})
        const newEntries=[...entries.values()],treeSha=gitTreeHash(newEntries),sha=gitCommitHash(treeSha,parent,body.message,'2026-09-02T00:00:00Z')
        trees.set(treeSha,newEntries);commits.set(sha,{sha,tree:{sha:treeSha},parents:[{sha:parent}],message:body.message});branches.set(body.branch,sha)
        response={content:{sha:blob},commit:{sha}}
      }else if(tail[0]==='pulls'){
        action='pull';response={number:pulls.length+1,body:body.body,title:body.title,draft:body.draft,state:'open',head:{ref:body.head,sha:branches.get(body.head),repo},base:{ref:body.base,repo}};pulls.push(response)
      }else return result(404)
      await afterMutation?.()
      if(failAction===action){failAction=undefined;throw new GitReadError('request_timeout',true)}
      return result(201,response)
    }}
}
