import {createHash} from 'node:crypto'
/** Original source identity excludes the reader/installation projection. */
export function teamOriginalRoot(provenance:unknown):string|null{
 if(!provenance||typeof provenance!=='object'||Array.isArray(provenance))return null
 const p=provenance as Record<string,unknown>
 if(p.source_kind!=='team_session'||!['team_id','team_session_id','team_call_id'].every(k=>typeof p[k]==='string'&&(p[k] as string).length>0))return null
 return 'team:'+createHash('sha256').update(JSON.stringify([p.team_id,p.team_session_id,p.team_call_id])).digest('hex')
}
export function manifestSourceRoots(manifest:unknown,sessionId:string,episodeId:string):string[]{
 const entries=manifest&&typeof manifest==='object'&&!Array.isArray(manifest)?Object.values(manifest as Record<string,unknown>):[]
 const roots=new Set<string>();let team=false,unknown=false
 for(const entry of entries){if(!entry||typeof entry!=='object')continue;const p=(entry as Record<string,unknown>).source_provenance
  if(p&&typeof p==='object'&&(p as Record<string,unknown>).source_kind==='team_session'){team=true;const root=teamOriginalRoot(p);if(root)roots.add(root);else unknown=true}}
 if(unknown)return []
 return team?[...roots].sort():[`native-session:${sessionId||episodeId}`]
}
export function independentSourceCount(facts:readonly {sessionId:string;episodeId:string;sourceRootIds?:readonly string[]}[]):number{
 const groups:{sessions:Set<string>;episodes:Set<string>;roots:Set<string>}[]=[]
 for(const fact of facts){const roots=new Set(fact.sourceRootIds??[`native-session:${fact.sessionId}`]);if(!fact.sessionId||!fact.episodeId||!roots.size)continue
  const overlapping=groups.filter(g=>g.sessions.has(fact.sessionId)||g.episodes.has(fact.episodeId)||[...roots].some(r=>g.roots.has(r)))
  const merged={sessions:new Set([fact.sessionId]),episodes:new Set([fact.episodeId]),roots}
  for(const g of overlapping){for(const s of g.sessions)merged.sessions.add(s);for(const e of g.episodes)merged.episodes.add(e);for(const r of g.roots)merged.roots.add(r);groups.splice(groups.indexOf(g),1)}groups.push(merged)
 }
 return groups.length
}
