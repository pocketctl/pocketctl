import { describe, expect, test } from 'vitest'
import { assetContentHash } from '../git-sync/codec.js'
import { planAssetMerge, planAssetTreeMerge, snapshotDigest } from '../git-sync/merge.js'
import { decodeAsset, encodeAsset } from '../git-sync/codec.js'
import { validateRepositoryFiles } from '../git-sync/paths.js'
import { fixtureId, phase6Snapshot } from '../testing/phase6-fixtures.js'
import type { AssetKind, AssetSnapshot, SkillAsset, WikiAsset } from '../git-sync/types.js'

const snapshot = (kind: AssetKind = 'claim') => {
  const value = phase6Snapshot(kind)
  value.contentHash = assetContentHash(value.asset)
  return value
}
function edit(base: AssetSnapshot, fn: (asset: any) => void): AssetSnapshot {
  const next = structuredClone(base)
  fn(next.asset)
  next.contentHash = assetContentHash(next.asset)
  return next
}
const doc = { statement: '保留 Evidence 与精确版本。', structuredContent: { value: null, flags: ['a'], retries: 2, enabled: true } }
describe('deterministic B/M/G planning', () => {
  test.each(['constructor','toString','valueOf','hasOwnProperty'])('codec accepted own %s deletion merges with an independent edit',key=>{
    const B=edit(snapshot('rule'),a=>{a.editable.structuredContent={[key]:'retained',a:'old'}})
    const M=edit(B,a=>{delete a.editable.structuredContent[key]})
    const G=edit(B,a=>{a.editable.structuredContent.a='new'})
    const wire=(s:AssetSnapshot)=>{const asset=decodeAsset(encodeAsset(s.asset),s);return {...s,asset,contentHash:assetContentHash(asset)}}
    expect(planAssetMerge(wire(B),wire(M),wire(G))).toMatchObject({kind:'proposal',asset:{asset:{editable:{structuredContent:{a:'new'}}}}})
    expect((decodeAsset(encodeAsset(M.asset),B).editable as any).structuredContent[key]).toBe('retained')
    const result=planAssetMerge(wire(B),wire(M),wire(G))
    if(result.kind==='conflict')throw new Error('unexpected conflict')
    expect(Object.hasOwn((result.asset.asset.editable as any).structuredContent,key)).toBe(false)
    expect(planAssetMerge(wire(B),wire(B),wire(G))).toMatchObject({asset:{asset:{editable:{structuredContent:{[key]:'retained',a:'new'}}}}})
  })
  test('all six ADR cases use independent complete document expectations', () => {
    const B = snapshot(), M = edit(B, a => { a.editable.statement = 'Memory statement'; a.baseRevision = '9007199254740994' }),
      G = edit(B, a => { a.editable.structuredContent.retries = 5 }), same = edit(B, a => { a.editable.statement = 'Memory statement' })
    const cases = [
      { M: B, G: B, kind: 'noop', document: doc },
      { M, G: B, kind: 'export', document: { ...doc, statement: 'Memory statement' } },
      { M: B, G, kind: 'proposal', document: { statement: doc.statement, structuredContent: { value: null, flags: ['a'], retries: 5, enabled: true } } },
      { M, G: same, kind: 'noop', document: { ...doc, statement: 'Memory statement' } },
      { M, G, kind: 'proposal', document: { statement: 'Memory statement', structuredContent: { value: null, flags: ['a'], retries: 5, enabled: true } } },
    ]
    for (const row of cases) {
      const result = planAssetMerge(B, row.M, row.G)
      expect(result.kind).toBe(row.kind)
      if (result.kind === 'conflict') throw new Error('unexpected conflict')
      expect(result.asset.asset.editable).toEqual(row.document)
      expect(result.asset.asset.serverOnly).toEqual(row.M.asset.serverOnly)
      expect(result.asset.asset.baseRevision).toBe(row.M.asset.baseRevision)
    }
    expect(planAssetMerge(B, M, edit(B, a => { a.editable.statement = 'Git statement' }))).toEqual({kind:'conflict',conflicts:[{field:'editable.statement',reason:'both_modified'}]})
  })
  test('arrays and each Markdown body are atomic, object fields merge independently', () => {
    const B = snapshot()
    expect(planAssetMerge(B, edit(B,a=>{a.editable.structuredContent.flags=['a','m']}), edit(B,a=>{a.editable.structuredContent.flags=['a','g']})))
      .toEqual({kind:'conflict',conflicts:[{field:'editable.structuredContent.flags',reason:'both_modified'}]})
    const W = snapshot('wiki')
    expect(planAssetMerge(W,edit(W,a=>{a.editable.pages[0].sections[0].markdown='Memory\nbody'}),edit(W,a=>{a.editable.pages[0].sections[0].markdown='Git\nbody'})))
      .toMatchObject({kind:'conflict',conflicts:[{reason:'both_modified'}]})
  })
  test('deletion, delete/edit, and tombstones never silently resurrect', () => {
    const B=snapshot(), removed={...B,deleted:true}, changed=edit(B,a=>{a.editable.statement='Changed'})
    expect(planAssetMerge(B,B,removed)).toMatchObject({kind:'proposal',asset:{deleted:true}})
    expect(planAssetMerge(B,removed,B)).toMatchObject({kind:'export',asset:{deleted:true}})
    expect(planAssetMerge(B,removed,removed)).toMatchObject({kind:'noop',asset:{deleted:true}})
    expect(planAssetMerge(B,changed,removed)).toEqual({kind:'conflict',conflicts:[{field:'deleted',reason:'delete_edit'}]})
    expect(planAssetMerge(B,removed,changed)).toMatchObject({kind:'conflict'})
    expect(()=>planAssetMerge(removed,removed,changed)).toThrow('base_deleted')
  })
  test('path participates separately from content; divergent rename and batch collision are explicit', () => {
    const B=snapshot(), M=edit(B,a=>{a.path='.pocketctl/knowledge/claims/m.yaml'}), G=edit(B,a=>{a.path='.pocketctl/knowledge/claims/g.yaml'})
    expect(planAssetMerge(B,B,G)).toMatchObject({kind:'proposal',asset:{asset:{path:G.asset.path}}})
    expect(planAssetMerge(B,M,G)).toEqual({kind:'conflict',conflicts:[{field:'path',reason:'rename_collision'}]})
    const B2=edit(B,a=>{a.key.id=fixtureId(100);a.path='.pocketctl/knowledge/claims/other.yaml'})
    const collide=edit(B,a=>{a.path='.pocketctl/knowledge/claims/OTHER.yaml'})
    const results=planAssetTreeMerge([B,B2],[B,B2],[collide,B2])
    expect(results.map(r=>r.result.kind)).toEqual(['conflict','conflict'])
  })
  test('collision fallback reaches closure for B=[a,b,d], M=[a,b,c], G=[b,c,d]',()=>{
    const B=['a','b','d'].map((name,i)=>edit(snapshot(),a=>{a.key.id=fixtureId(101+i);a.path=`.pocketctl/knowledge/claims/${name}.yaml`}))
    const M=B.map((b,i)=>edit(b,a=>{a.path=`.pocketctl/knowledge/claims/${['a','b','c'][i]}.yaml`}))
    const G=B.map((b,i)=>edit(b,a=>{a.path=`.pocketctl/knowledge/claims/${['b','c','d'][i]}.yaml`}))
    for(const tree of [B,M,G])expect(()=>validateRepositoryFiles(tree.flatMap(s=>encodeAsset(s.asset)))).not.toThrow()
    const plans=planAssetTreeMerge(B,M,G)
    expect(plans.map(p=>p.result.kind)).toEqual(['conflict','conflict','conflict'])
    const effective=plans.flatMap((p,i)=>encodeAsset(p.result.kind==='conflict'?M[i].asset:p.result.asset.asset))
    expect(effective.map(f=>f.path)).toEqual(['.pocketctl/knowledge/claims/a.yaml','.pocketctl/knowledge/claims/b.yaml','.pocketctl/knowledge/claims/c.yaml'])
    expect(()=>validateRepositoryFiles(effective)).not.toThrow()
  })
  test('independent valid renames cannot produce a file that is another output directory',()=>{
    const B=['x.yaml','y.yaml'].map((name,i)=>edit(snapshot(),a=>{a.key.id=fixtureId(201+i);a.path=`.pocketctl/knowledge/claims/${name}`}))
    const M=[B[0],edit(B[1],a=>{a.path='.pocketctl/knowledge/claims/z.yaml/child.yaml'})]
    const G=[edit(B[0],a=>{a.path='.pocketctl/knowledge/claims/Z.yaml'}),B[1]]
    for(const tree of [B,M,G])expect(()=>validateRepositoryFiles(tree.flatMap(s=>encodeAsset(s.asset)))).not.toThrow()
    const plans=planAssetTreeMerge(B,M,G)
    expect(plans.map(p=>p.result.kind)).toEqual(['conflict','conflict'])
    expect(()=>validateRepositoryFiles(plans.flatMap((p,i)=>encodeAsset(p.result.kind==='conflict'?M[i].asset:p.result.asset.asset)))).not.toThrow()
  })
  test.each(['key','sourceDigest','baseRevision','evidence','serverOnly','sourceTokens'])('rejects Git mutation to protected %s, not a resolvable conflict', field => {
    const B=snapshot(field==='sourceTokens'?'skill':'claim'), G=edit(B,a=>{
      if(field==='key')a.key.id=fixtureId(88)
      if(field==='sourceDigest')a.sourceDigest='b'.repeat(64)
      if(field==='baseRevision')a.baseRevision='3'
      if(field==='evidence')a.immutable.evidence[0].hash='b'.repeat(64)
      if(field==='serverOnly')a.serverOnly.updatedAt='2026-09-03T01:00:00.000Z'
      if(field==='sourceTokens')a.editable.document.source_tokens=['forged']
    })
    expect(()=>planAssetMerge(B,B,G)).toThrow('immutable_field_changed')
  })
  test('valid historical B merges against newer M and digests include source and revision', () => {
    const B=snapshot(), M=edit(B,a=>{a.baseVersionId=fixtureId(50);a.baseRevision='9007199254740994';a.sourceDigest='b'.repeat(64);a.serverOnly.branch='new';a.editable.statement='Memory'})
    const G=edit(B,a=>{a.editable.structuredContent.enabled=false}), result=planAssetMerge(B,M,G)
    expect(result).toMatchObject({kind:'proposal',asset:{asset:{baseVersionId:fixtureId(50),sourceDigest:'b'.repeat(64),serverOnly:{branch:'new'},
      editable:{statement:'Memory',structuredContent:{value:null,flags:['a'],retries:2,enabled:false}}}}})
    expect(snapshotDigest(M)).not.toBe(snapshotDigest(edit(M,a=>{a.baseRevision='9007199254740995'})))
  })
  test('Skill editable document fields merge with current draft, without inheriting B source tokens', () => {
    const B=snapshot('skill'), M=edit(B,a=>{a.baseVersionId=fixtureId(90);a.immutable.state='draft';a.editable.document.title='Draft title';a.editable.document.source_tokens=['current-source'];a.serverOnly.editableHeadVersionId=fixtureId(90)}), G=edit(B,a=>{a.editable.document.trigger='Git trigger'})
    const result=planAssetMerge(B,M,G)
    expect(result.kind).toBe('proposal')
    if(result.kind==='conflict')throw new Error('unexpected')
    expect((result.asset.asset as SkillAsset).editable.document).toEqual({schema_version:'skill-candidate.v1',title:'Draft title',trigger:'Git trigger',
      preconditions:['本地合成输入'],steps:[{instruction:'读取状态',tool:'read',permissions:['read'],operation:'read'}],validation:['状态正确'],failure_handling:['停止'],rollback:['无更改'],source_tokens:['current-source']})
  })
})

describe('Wiki stable semantic identities',()=>{
  function regenerate(B:AssetSnapshot) {
    return edit(B,a=>{a.baseVersionId=fixtureId(95);a.baseRevision='9007199254740994';a.editable.pages[0].pageId=fixtureId(70);a.immutable.pages[0].pageId=fixtureId(70)
      for(let i=0;i<2;i++){a.editable.pages[0].sections[i].sectionId=fixtureId(71+i);a.immutable.pages[0].sections[i].sectionId=fixtureId(71+i)}})
  }
  test('new DB page/section IDs do not change domain hash or create proposals',()=>{
    const B=snapshot('wiki'),M=regenerate(B)
    expect(assetContentHash(M.asset)).toBe(assetContentHash(B.asset))
    expect(planAssetMerge(B,M,B)).toMatchObject({kind:'noop'})
  })
  test.each(['title','heading','coverage','markdown','order'])('semantic %s changes remain significant',field=>{
    const B=snapshot('wiki'),G=edit(B,a=>{
      if(field==='title')a.editable.pages[0].title='New'
      if(field==='heading')a.editable.pages[0].sections[0].heading='New'
      if(field==='coverage')a.editable.pages[0].sections[0].coverage='unsupported'
      if(field==='markdown')a.editable.pages[0].sections[0].markdown='New'
      if(field==='order'){a.editable.pages[0].sections.reverse();a.immutable.pages[0].sections.reverse()}
    })
    expect(G.contentHash).not.toBe(B.contentHash)
  })
  test('matches original G IDs to B keys then retains regenerated M IDs and all content',()=>{
    const B=snapshot('wiki'),M=edit(regenerate(B),a=>{a.editable.pages[0].title='Memory title'}),G=edit(B,a=>{a.editable.pages[0].sections[0].sectionKey='renamed';a.editable.pages[0].sections[0].markdown='Git body'})
    const result=planAssetMerge(B,M,G)
    expect(result.kind).toBe('proposal');if(result.kind==='conflict')throw new Error('unexpected')
    expect((result.asset.asset as WikiAsset).editable).toEqual({pages:[{pageId:fixtureId(70),title:'Memory title',sections:[
      {sectionId:fixtureId(71),sectionKey:'renamed',heading:'标题',markdown:'Git body',coverage:'complete'},
      {sectionId:fixtureId(72),sectionKey:'details',heading:'细节',markdown:'  保留空格\r\n原始换行\r\n',coverage:'partial'}]}]})
  })
  test.each(['locked','authority','lock_version','ambiguous_structure'])('protects %s during Git edits',scenario=>{
    const B=snapshot('wiki'),M=edit(regenerate(B),a=>{
      if(scenario==='authority')a.immutable.pages[0].sections[0].authority='locked'
      if(scenario==='lock_version')a.immutable.pages[0].sections[0].lockVersion='3'
      if(scenario==='ambiguous_structure')a.editable.pages[0].sections[0].sectionKey='unknown'
    }),G=edit(B,a=>{a.editable.pages[0].sections[scenario==='locked'?1:0].markdown='Git'})
    expect(planAssetMerge(B,M,G).kind).toBe('conflict')
  })
  test('two-side section rename and key collisions are explicit',()=>{
    const B=snapshot('wiki'),M=edit(B,a=>{a.editable.pages[0].sections[0].sectionKey='memory'}),G=edit(B,a=>{a.editable.pages[0].sections[0].sectionKey='git'})
    expect(planAssetMerge(B,M,G)).toMatchObject({kind:'conflict',conflicts:[{reason:'rename_collision'}]})
    const M2=edit(B,a=>{a.editable.pages[0].sections[1].sectionKey='new'}),G2=edit(B,a=>{a.editable.pages[0].sections[0].sectionKey='new'})
    expect(planAssetMerge(B,M2,G2)).toMatchObject({kind:'conflict',conflicts:[{field:'editable.sectionKeys',reason:'rename_collision'}]})
  })
  test('whole-Wiki deletion honors newly acquired M lock even when body is unchanged',()=>{
    const B=edit(snapshot('wiki'),a=>{a.immutable.pages[0].sections[1].authority='manual'}),M=edit(B,a=>{a.immutable.pages[0].sections[0].authority='locked'})
    expect(planAssetMerge(B,M,{...B,deleted:true})).toEqual({kind:'conflict',conflicts:[{field:'deleted',reason:'locked'}]})
  })
})
