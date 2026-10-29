/** Advisory task requirements. Repository references never grant execution access. */
export interface TaskRequirements {
  goal: string
  scope: string
  acceptance: string
  repository: {kind:'git';url:string}|{kind:'not_applicable';reason:string}|null
}
export type RequirementField='goal'|'scope'|'repository'|'acceptance'
export function parseTaskRequirements(value:unknown):TaskRequirements {
  const object=(v:unknown,keys:string[])=>{
    if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new Error('invalid requirements')
    return v as Record<string,unknown>
  }
  const text=(v:unknown,max:number)=>{
    if(typeof v!=='string'||v.length>max||v.includes('\0'))throw new Error('invalid requirements text')
    return v.trim()
  }
  const body=object(value,['goal','scope','acceptance','repository'])
  let repository:TaskRequirements['repository']=null
  if(body.repository!==null){
    const repo=object(body.repository,['kind','url','reason'])
    if(repo.kind==='git'){
      if(Object.keys(repo).some(k=>!['kind','url'].includes(k)))throw new Error('invalid repository')
      const raw=text(repo.url,2048)
      // HTTPS origin/path only: no credentials, fragments, query secrets or
      // traversal hidden by URL normalization. This field is never fetched.
      if(/[\s\\]/.test(raw)||/%2f|%5c/i.test(raw))throw new Error('invalid repository')
      const path=decodeURIComponent(raw.replace(/^https:\/\/[^/]+/,''))
      if(path.split('/').some(part=>part==='.'||part==='..'))throw new Error('invalid repository')
      const url=new URL(raw)
      if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname==='/')throw new Error('invalid repository')
      repository={kind:'git',url:url.href}
    }else if(repo.kind==='not_applicable'){
      if(Object.keys(repo).some(k=>!['kind','reason'].includes(k)))throw new Error('invalid repository')
      const reason=text(repo.reason,1000);if(!reason)throw new Error('repository reason required')
      repository={kind:'not_applicable',reason}
    }else throw new Error('invalid repository kind')
  }
  return {goal:text(body.goal,10000),scope:text(body.scope,10000),acceptance:text(body.acceptance,10000),repository}
}
export function taskReadiness(requirements:TaskRequirements):{status:'ready'|'needs_information';missing:RequirementField[]} {
  const missing:RequirementField[]=[]
  for(const field of ['goal','scope','repository','acceptance'] as const)if(!requirements[field])missing.push(field)
  return {status:missing.length?'needs_information':'ready',missing}
}
