import { canonicalJsonString, canonicalPayloadHash } from '../inbox/canonical-json.js'
import { assetContentHash, encodeAsset } from './codec.js'
import { normalizedPathsOverlap, validateRepositoryPath } from './paths.js'
import { PortableAssetSchema, type AssetKey, type AssetSnapshot, type FieldConflict, type MergeResult, type PortableAsset, type SkillAsset, type WikiAsset } from './types.js'

const equal = (a: unknown, b: unknown): boolean => a === undefined || b === undefined ? a === b : canonicalJsonString(a) === canonicalJsonString(b)
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value: Record<string, unknown>, key: string): unknown => Object.hasOwn(value, key) ? value[key] : undefined
const keyOf = (snapshot: AssetSnapshot) => `${snapshot.asset.key.kind}:${snapshot.asset.key.id}`
const same = (a: AssetSnapshot, b: AssetSnapshot) => a.deleted === b.deleted && (a.deleted || (a.asset.path === b.asset.path && assetContentHash(a.asset) === assetContentHash(b.asset)))
export const asAssetSnapshot = (asset: PortableAsset, deleted = false): AssetSnapshot => ({asset, contentHash: assetContentHash(asset), deleted})
/** Exact input fence, intentionally distinct from the semantic content hash. */
export function snapshotDigest(value: AssetSnapshot): string {
  return canonicalPayloadHash({asset:value.asset,deleted:value.deleted}).toString('hex')
}
function validateGitEdit(base: PortableAsset, git: PortableAsset) {
  for (const field of ['schemaVersion','key','connectionId','exportId','baseVersionId','baseRevision','sourceDigest','immutable','serverOnly'] as const) {
    if (!equal(base[field],git[field])) throw new Error('immutable_field_changed')
  }
  if (base.key.kind==='skill' && !equal((base as SkillAsset).editable.document.source_tokens,(git as SkillAsset).editable.document.source_tokens)) throw new Error('immutable_field_changed')
  if(base.key.kind==='wiki') {
    const before=(base as WikiAsset).editable.pages,after=(git as WikiAsset).editable.pages
    if(!equal(before.map(p=>[p.pageId,p.sections.map(s=>s.sectionId)]),after.map(p=>[p.pageId,p.sections.map(s=>s.sectionId)])))throw new Error('immutable_field_changed')
  }
}
function mergeField(base: unknown, memory: unknown, git: unknown, field: string, conflicts: FieldConflict[]): unknown {
  if(equal(memory,git)||equal(base,git))return structuredClone(memory)
  if(equal(base,memory))return structuredClone(git)
  if(record(base)&&record(memory)&&record(git)) {
    return Object.fromEntries([...new Set([...Object.keys(base),...Object.keys(memory),...Object.keys(git)])].sort().flatMap(key=>{
      const result=mergeField(own(base,key),own(memory,key),own(git,key),`${field}.${key}`,conflicts)
      return result===undefined?[]:[[key,result]]
    }))
  }
  conflicts.push({field,reason:field==='path'||field.endsWith('.sectionKey')?'rename_collision':'both_modified'})
  return structuredClone(memory)
}
function mergeWiki(base: WikiAsset, memory: WikiAsset, git: WikiAsset, conflicts: FieldConflict[]): WikiAsset['editable'] {
  const output=structuredClone(memory.editable)
  // Page identity is immutable pageKey; G's physical IDs are interpreted only
  // against B. A regenerated M row may match the original stable sectionKey.
  if(base.immutable.pages.length!==memory.immutable.pages.length) {
    conflicts.push({field:'editable.pages',reason:'delete_edit'});return output
  }
  const usedSections=new Set<string>()
  for(const [bi,bp] of base.immutable.pages.entries()) {
    const mi=memory.immutable.pages.findIndex(p=>p.pageKey===bp.pageKey)
    if(mi<0){conflicts.push({field:'editable.pages',reason:'delete_edit'});continue}
    const before=base.editable.pages[bi],current=memory.editable.pages[mi],incoming=git.editable.pages[bi],target=output.pages[mi]
    const prefix=`editable.pages.${bp.pageKey}`
    target.title=mergeField(before.title,current.title,incoming.title,`${prefix}.title`,conflicts) as string
    if(before.sections.length!==current.sections.length){conflicts.push({field:`${prefix}.sections`,reason:'delete_edit'});continue}
    for(const [si,bs] of before.sections.entries()) {
      const candidates=current.sections.filter(s=>s.sectionId===bs.sectionId)
      const matches=candidates.length?candidates:current.sections.filter(s=>s.sectionKey===bs.sectionKey)
      if(matches.length!==1||usedSections.has(matches[0].sectionId)){conflicts.push({field:`${prefix}.sections`,reason:'delete_edit'});continue}
      const ms=matches[0],gi=incoming.sections[si],index=current.sections.indexOf(ms),msMeta=memory.immutable.pages[mi].sections[index],bsMeta=bp.sections[si]
      usedSections.add(ms.sectionId)
      const field=`${prefix}.sections.${bs.sectionKey}`
      const changed=!equal({...bs,sectionId:undefined},{...gi,sectionId:undefined})
      if(changed&&(bsMeta.authority==='locked'||msMeta.authority==='locked'||bsMeta.authority!==msMeta.authority||bsMeta.lockVersion!==msMeta.lockVersion)) {
        conflicts.push({field,reason:'locked'});continue
      }
      for(const name of ['sectionKey','heading','markdown','coverage'] as const) {
        (target.sections[index] as unknown as Record<string,unknown>)[name]=mergeField(bs[name],ms[name],gi[name],`${field}.${name}`,conflicts)
      }
    }
  }
  const keys=output.pages.flatMap(p=>p.sections.map(s=>s.sectionKey))
  if(new Set(keys).size!==keys.length)conflicts.push({field:'editable.sectionKeys',reason:'rename_collision'})
  return output
}
/** Pure deterministic planning. B is a registered snapshot; M is an authorized
 * current projection; G is an untrusted baseline-relative edit. Never applies. */
export function planAssetMerge(base: AssetSnapshot, memory: AssetSnapshot, git: AssetSnapshot): MergeResult {
  for(const value of [base,memory,git]) {
    PortableAssetSchema.parse(value.asset)
    if(value.contentHash!==assetContentHash(value.asset))throw new Error('git_snapshot_hash_mismatch')
  }
  validateGitEdit(base.asset,git.asset)
  if(!equal(base.asset.key,memory.asset.key)||base.asset.connectionId!==memory.asset.connectionId
    || !equal([base.asset.immutable.installationId,base.asset.immutable.ownerScopeKind,base.asset.immutable.ownerScopeId],
      [memory.asset.immutable.installationId,memory.asset.immutable.ownerScopeKind,memory.asset.immutable.ownerScopeId]))throw new Error('immutable_field_changed')
  if(base.deleted&&(!memory.deleted||!git.deleted))throw new Error('base_deleted')
  if(same(base,git))return {kind:same(base,memory)?'noop':'export',asset:structuredClone(memory)}
  if(memory.deleted||git.deleted) {
    if(same(memory,git))return {kind:'noop',asset:structuredClone(memory)}
    if(!same(base,memory))return {kind:'conflict',conflicts:[{field:'deleted',reason:'delete_edit'}]}
    if(base.asset.key.kind==='wiki'&&[base,memory].some(snapshot=>(snapshot.asset as WikiAsset).immutable.pages.some(p=>p.sections.some(s=>s.authority==='locked'))))return {kind:'conflict',conflicts:[{field:'deleted',reason:'locked'}]}
    return {kind:'proposal',asset:asAssetSnapshot(structuredClone(memory.asset),true)}
  }
  const conflicts:FieldConflict[]=[],merged=structuredClone(memory.asset)
  merged.path=mergeField(base.asset.path,memory.asset.path,git.asset.path,'path',conflicts) as string
  if(base.asset.key.kind==='wiki')merged.editable=mergeWiki(base.asset as WikiAsset,memory.asset as WikiAsset,git.asset as WikiAsset,conflicts)
  else {
    merged.editable=mergeField(base.asset.editable,memory.asset.editable,git.asset.editable,'editable',conflicts) as PortableAsset['editable']
  }
  if(conflicts.length)return {kind:'conflict',conflicts:[...new Map(conflicts.map(c=>[c.field,c])).values()].sort((a,b)=>a.field.localeCompare(b.field))}
  const next=asAssetSnapshot(PortableAssetSchema.parse(merged))
  return {kind:same(next,memory)?'noop':'proposal',asset:next}
}
export interface AssetMergePlan { key:AssetKey; result:MergeResult }
/** Close over collision -> current-M fallback. Outside files and opaque reserved
 * directories participate in every round; a new conflict can expose a new path.
 * At most one transition to conflict per asset makes this bounded and monotone. */
export function closeAssetNamespace(plans:AssetMergePlan[],memory:AssetSnapshot[],reservedPaths:readonly string[]=[]):AssetMergePlan[] {
  const output=structuredClone(plans),reserved=reservedPaths.map(path=>validateRepositoryPath(path))
  for(let round=0;round<=output.length;round++) {
    const occupied:{path:string;index:number}[]=[],collisions=new Set<number>()
    output.forEach((plan,index)=>{
      const snapshot=plan.result.kind==='conflict'?memory.find(m=>equal(m.asset.key,plan.key))!:plan.result.asset
      if(snapshot.deleted)return
      for(const file of encodeAsset(snapshot.asset)) {
        const path=validateRepositoryPath(file.path)
        if(reserved.some(other=>normalizedPathsOverlap(path,other)))collisions.add(index)
        for(const other of occupied)if(normalizedPathsOverlap(path,other.path)){collisions.add(index);collisions.add(other.index)}
        occupied.push({path,index})
      }
    })
    let changed=false
    for(const index of collisions) {
      const plan=output[index],prior=plan.result.kind==='conflict'?plan.result.conflicts:[]
      if(plan.result.kind!=='conflict')changed=true
      plan.result={kind:'conflict',conflicts:[...prior.filter(c=>c.field!=='path'),{field:'path',reason:'rename_collision'}]}
    }
    if(!changed)return output
  }
  throw new Error('git_namespace_unstable')
}
/** Cross-asset collisions include Wiki pages, not only metadata paths. */
export function planAssetTreeMerge(base: AssetSnapshot[], memory: AssetSnapshot[], git: AssetSnapshot[]): AssetMergePlan[] {
  for(const tree of [base,memory,git])for(const snapshot of tree)validateRepositoryPath(snapshot.asset.path)
  const keys=base.map(keyOf).sort()
  if(new Set(keys).size!==keys.length||!equal(keys,memory.map(keyOf).sort())||!equal(keys,git.map(keyOf).sort()))throw new Error('git_tree_identity')
  const plans=base.map(b=>({key:b.asset.key,result:planAssetMerge(b,memory.find(m=>keyOf(m)===keyOf(b))!,git.find(g=>keyOf(g)===keyOf(b))!)}))
  return closeAssetNamespace(plans,memory)
}
