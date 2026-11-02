export type SceneDomain='personal_project'|'work'|'life'|'profile'
export type SceneDestination='personal'|'work'|'shared'
/** Only pass spaces loaded inside a revalidated installation grant. This pure
 * selector narrows applicability; it never authorizes access or loads bodies. */
export interface SceneSpace {
 spaceId:string
 domain:SceneDomain
 destinations:readonly SceneDestination[]
 repositoryKeys:readonly string[]
}
export interface SceneSelection {status:'resolved'|'unresolved';spaceId?:string;reason:string}
export function selectScene(input:{spaces:readonly SceneSpace[];destination:SceneDestination;explicitSpaceId?:string|null;repositoryKey?:string|null}):SceneSelection {
 const allowed=input.spaces.filter(s=>s.destinations.includes(input.destination))
 if(input.explicitSpaceId!==undefined&&input.explicitSpaceId!==null){
  const matches=allowed.filter(s=>s.spaceId===input.explicitSpaceId)
  return matches.length===1?{status:'resolved',spaceId:matches[0].spaceId,reason:'explicit'}:{status:'unresolved',reason:'explicit_space_unavailable'}
 }
 const matches=input.repositoryKey?allowed.filter(s=>s.repositoryKeys.includes(input.repositoryKey!)):[]
 return matches.length===1?{status:'resolved',spaceId:matches[0].spaceId,reason:'repository'}:{status:'unresolved',reason:matches.length>1?'ambiguous_repository':'scene_unknown'}
}
