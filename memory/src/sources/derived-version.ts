import type {SourceVersion} from '@pocketctl/session-source'
/** Moving identical bodies between hot/cold storage does not invalidate
 * already-derived content. This predicate is only for projection readiness;
 * actual body reads and physical commit fences still bind all three fields. */
export function sameDerivedSourceVersion(a:SourceVersion|undefined,b:SourceVersion|undefined):boolean{
 return !!a&&!!b&&typeof a.content==='string'&&typeof a.authorization==='string'
  &&a.content===b.content&&a.authorization===b.authorization
}
