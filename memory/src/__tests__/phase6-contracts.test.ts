import { describe, expect, it } from 'vitest'
import { encodeAsset, decodeAsset, assetContentHash, parseStrictJson } from '../git-sync/codec.js'
import { DOMAIN_FIELD_MAPPING, FIELD_MAPPING, PortableAssetSchema, type RepositoryFile, type WikiAsset } from '../git-sync/types.js'
import { validateRepositoryFiles, validateAssetPaths } from '../git-sync/paths.js'
import { changeMetadata, fixtureId, phase6Snapshot } from '../testing/phase6-fixtures.js'

describe('Phase 6 portable contracts', () => {
  it.each([
    ['.pocketctl/knowledge/claims/z.yaml','.pocketctl/knowledge/claims/Z.yaml/child.yaml'],
    ['.pocketctl/knowledge/claims/café.yaml','.pocketctl/knowledge/claims/cafe\u0301.yaml/child.yaml'],
  ])('rejects normalized file/directory ancestry %s in either input order', (ancestor,descendant)=>{
    const a=phase6Snapshot().asset,b=phase6Snapshot().asset
    b.key.id=fixtureId(99)
    for(const paths of [[ancestor,descendant],[descendant,ancestor]]) {
      expect(()=>validateRepositoryFiles(paths.map(path=>({path,mode:'100644' as const,bytes:Buffer.from('body')})))).toThrow('path_collision')
      expect(()=>validateAssetPaths([{...a,path:paths[0]},{...b,path:paths[1]}])).toThrow('path_collision')
    }
    expect(()=>validateRepositoryFiles([`${ancestor}/left.yaml`,`${ancestor}/right.yaml`,`${ancestor}-sibling.yaml`].map(path=>({path,mode:'100644' as const,bytes:Buffer.from('body')})))).not.toThrow()
  })
  for (const kind of ['claim', 'rule', 'wiki', 'skill'] as const) {
    it(`${kind} preserves all fields including private server values without exporting them`, () => {
      const base = phase6Snapshot(kind)
      const files = encodeAsset(base.asset)
      expect(decodeAsset(files, base)).toEqual(base.asset)
      expect(Buffer.concat(files.map(f => Buffer.from(f.bytes))).toString()).not.toMatch(/serverOnly|private excerpt|privatePath|policySnapshot|authorId/)
      expect(files.every(f => f.mode === '100644')).toBe(true)
      for (const category of ['immutable', 'editable', 'serverOnly'] as const) {
        expect(Object.keys(FIELD_MAPPING[kind][category]).sort()).toEqual(Object.keys(base.asset[category]).sort())
      }
    })
  }

  it('retains omitted editable fields from base but applies edits to supplied fields', () => {
    const base = phase6Snapshot()
    const files = changeMetadata(encodeAsset(base.asset), v => { v.editable = { statement: '明确的本地修改' } })
    const result = decodeAsset(files, base)
    expect(result.editable).toEqual({ ...base.asset.editable, statement: '明确的本地修改' })
    expect(result.serverOnly).toEqual(base.asset.serverOnly)
  })
  it('rejects explicit null editable payloads rather than treating them as omitted', () => {
    const base = phase6Snapshot()
    expect(() => decodeAsset(changeMetadata(encodeAsset(base.asset), v => { v.editable = null }), base)).toThrow('invalid_editable')
  })
  it('preserves omitted Wiki section metadata while reading explicit body changes', () => {
    const base = phase6Snapshot('wiki')
    const files = changeMetadata(encodeAsset(base.asset), v => { v.editable.pages = [{ pageId: fixtureId(20), title: '新标题' }] })
    expect((decodeAsset(files, base).editable as any).pages[0]).toEqual({ ...(base.asset.editable as any).pages[0], title: '新标题' })
  })
  it('allows file-backed Wiki with no Claim Evidence and rejects cross-source Skill tokens', () => {
    const wiki = phase6Snapshot('wiki')
    ;(wiki.asset.immutable as any).evidence = []
    ;(wiki.asset.immutable as any).pages[0].sections[0].sourceBindings[0].sourceKind = 'file'
    expect(decodeAsset(encodeAsset(wiki.asset), wiki)).toEqual(wiki.asset)
    const skill = phase6Snapshot('skill')
    expect(() => decodeAsset(changeMetadata(encodeAsset(skill.asset), v => { v.editable.document.source_tokens = ['forged'] }), skill)).toThrow('immutable_field_changed')
  })
  it('preserves every claim provenance column, including governance fields added by migrations', () => {
    const base = phase6Snapshot()
    const extended = structuredClone(base.asset) as any
    extended.immutable.authority = 'organization_published'
    Object.assign(extended.serverOnly, { conflictGroupId: fixtureId(40), conflictVariant: 3,
      sourcePromotionCandidateId: fixtureId(41), claimCreatedAt: '2026-08-01T00:00:00.000Z' })
    Object.assign(extended.serverOnly.evidence[0], { contributorMembershipId: fixtureId(42), sourceEvidenceHash: 'b'.repeat(64) })
    expect(decodeAsset(encodeAsset(extended), { ...base, asset: extended })).toEqual(extended)
    expect(Object.keys(DOMAIN_FIELD_MAPPING.knowledge_claims).sort()).toEqual([
      'claim_id', 'installation_id', 'claim_type', 'scope_kind', 'scope_key', 'normalized_key', 'state',
      'current_version_id', 'superseded_by_claim_id', 'revision', 'created_at', 'updated_at', 'owner_scope_kind',
      'owner_scope_id', 'conflict_group_id', 'conflict_variant',
    ].sort())
  })
  it('preserves Wiki row positions, generation, source timestamps and manual head metadata', () => {
    const base = phase6Snapshot('wiki')
    const asset = structuredClone(base.asset) as any
    asset.immutable.generatedRevision = '8'
    asset.immutable.pages[0].position = 4
    asset.immutable.pages[0].sections.forEach((s: any, i: number) => {
      s.position = i + 2
      s.sourceBindings[0].createdAt = '2026-08-01T00:00:00.000Z'
    })
    Object.assign(asset.serverOnly, { generation: '9', wikiCreatedAt: '2026-08-01T00:00:00.000Z',
      wikiUpdatedAt: '2026-09-01T00:00:00.000Z', manualHeads: [{ sectionKey: 'overview',
        currentVersionId: fixtureId(22), locked: false, lockVersion: '2', updatedAt: '2026-09-02T00:00:00.000Z' }] })
    expect(decodeAsset(encodeAsset(asset), { ...base, asset })).toEqual(asset)
  })
  it('preserves Skill identity and publication history timestamps', () => {
    const base = phase6Snapshot('skill')
    const asset = structuredClone(base.asset) as any
    Object.assign(asset.serverOnly, { skillCreatedAt: '2026-08-01T00:00:00.000Z', previousPublishedVersionId: fixtureId(43),
      publicationEventId: fixtureId(44), publicationUpdatedAt: '2026-09-02T00:00:00.000Z' })
    expect(decodeAsset(encodeAsset(asset), { ...base, asset })).toEqual(asset)
  })

  it.each(['baseVersionId', 'baseRevision', 'sourceDigest', 'connectionId', 'exportId', 'schemaVersion'])(
    'rejects forged baseline %s', field => {
      const base = phase6Snapshot()
      expect(() => decodeAsset(changeMetadata(encodeAsset(base.asset), v => { v[field] = field === 'baseRevision' ? '4' : fixtureId(98) }), base)).toThrow('immutable_field_changed')
    })

  it.each([
    ['claim', (v: any) => { v.immutable.ownerScopeId = fixtureId(98) }],
    ['claim', (v: any) => { v.immutable.evidence = [] }],
    ['skill', (v: any) => { v.immutable.risk = 'high' }],
    ['skill', (v: any) => { v.immutable.policyHash = 'b'.repeat(64) }],
    ['wiki', (v: any) => { v.immutable.pages[0].sections[0].manualVersionId = null }],
  ] as const)('rejects changes to %s authority and provenance', (kind, mutate) => {
    const base = phase6Snapshot(kind)
    expect(() => decodeAsset(changeMetadata(encodeAsset(base.asset), mutate), base)).toThrow('immutable_field_changed')
  })

  it.each([
    (v: any) => { v.owner = 'attacker' },
    (v: any) => { v.serverOnly = { policySnapshot: {} } },
    (v: any) => { v.editable.permissions = ['admin'] },
    (v: any) => { v.editable.statement = 'x'.repeat(4001) },
    (v: any) => { v.editable.structuredContent = { text: 'x'.repeat(513) } },
  ])('rejects unknown keys and upstream claim limits', mutate => {
    const base = phase6Snapshot()
    expect(() => decodeAsset(changeMetadata(encodeAsset(base.asset), mutate), base)).toThrow()
  })

  it('rejects a Rule type outside the two existing Claim types', () => {
    const base = phase6Snapshot('rule')
    expect(() => PortableAssetSchema.parse({ ...base.asset, immutable: { ...base.asset.immutable, claimType: 'ContextPolicy' } })).toThrow()
  })
  it('refuses assets without Evidence, malformed IDs/digests, lossy revision, and Skill schema additions', () => {
    const claim = phase6Snapshot().asset
    for (const invalid of [
      { ...claim, immutable: { ...claim.immutable, evidence: [] } },
      { ...claim, baseRevision: 9007199254740992 },
      { ...claim, baseRevision: '9223372036854775808' },
      { ...claim, sourceDigest: 'A'.repeat(64) },
      { ...claim, key: { kind: 'claim', id: '../escape' } },
    ]) expect(() => PortableAssetSchema.parse(invalid)).toThrow()
    const skill = phase6Snapshot('skill').asset
    expect(() => encodeAsset({ ...skill, editable: { document: { ...(skill.editable as any).document, risk: 'low' } } } as any)).toThrow()
  })

  it('preserves Wiki ordering, citations, section bytes, manual and lock revisions', () => {
    const base = phase6Snapshot('wiki')
    const files = encodeAsset(base.asset)
    const result = decodeAsset(files, base)
    expect(result.editable).toEqual(base.asset.editable)
    expect((result.immutable as any).pages[0].sections.map((s: any) => [s.authority, s.lockVersion])).toEqual([
      ['manual', '2'], ['locked', '9007199254740993'],
    ])
    const changed = files.map(f => f.path.endsWith('.md') ? { ...f, bytes: Buffer.from(Buffer.from(f.bytes).toString().replace('正文', '编辑正文')) } : f)
    expect((decodeAsset(changed, base).editable as any).pages[0].sections[0].markdown).toBe('\n编辑正文 [来源](evidence:1)\n\n')
  })
  it.each(['manual', 'locked'] as const)('round-trips published %s overlays without synthetic source bindings', authority => {
    const base = phase6Snapshot('wiki')
    const wiki = base.asset as WikiAsset
    const section = wiki.immutable.pages[0].sections[0]
    section.authority = authority
    section.sourceBindings = []
    wiki.editable.pages[0].sections[0].heading = 'overview'
    wiki.serverOnly.manualHeads[0].locked = authority === 'locked'
    expect(decodeAsset(encodeAsset(wiki), base)).toEqual(wiki)

    section.manualVersionId = null
    expect(() => encodeAsset(wiki)).toThrow()
    section.authority = 'generated'
    expect(() => encodeAsset(wiki)).toThrow()
  })
  it('rejects a section key duplicated across pages even when metadata and markers agree', () => {
    const base = phase6Snapshot('wiki')
    const wiki = base.asset as WikiAsset
    const origin = wiki.immutable.pages[0]
    const page = wiki.editable.pages[0]
    wiki.immutable.pages.push({ pageId: fixtureId(50), pageKey: 'details', position: 1, sections: [origin.sections.pop()!] })
    wiki.editable.pages.push({ pageId: fixtureId(50), title: 'Details', sections: [page.sections.pop()!] })
    const original = encodeAsset(wiki)
    expect(decodeAsset(original, base)).toEqual(wiki)
    const changed = changeMetadata(original, value => { value.editable.pages[1].sections[0].sectionKey = 'overview' })
      .map(file => file.path.endsWith('/details.md')
        ? { ...file, bytes: Buffer.from(Buffer.from(file.bytes).toString('utf8').replace('"sectionKey":"details"', '"sectionKey":"overview"')) }
        : file)
    expect(() => decodeAsset(changed, base)).toThrow('wiki_structure_invalid')
  })
  it.each(['missing', 'duplicate', 'forged'])('rejects %s Wiki section markers', mutation => {
    const base = phase6Snapshot('wiki')
    const files = encodeAsset(base.asset).map(f => {
      if (!f.path.endsWith('.md')) return f
      let text = Buffer.from(f.bytes).toString()
      const marker = text.match(/<!-- pocketctl:section .*? -->/)![0]
      text = mutation === 'missing' ? text.replace(marker, '')
        : mutation === 'duplicate' ? text.replace(marker, `${marker}\n${marker}`)
          : text.replace(fixtureId(21), fixtureId(98))
      return { ...f, bytes: Buffer.from(text) }
    })
    expect(() => decodeAsset(files, base)).toThrow('wiki_marker_invalid')
  })
  it('recognizes a moved asset by stable identity and rejects duplicate IDs', () => {
    const base = phase6Snapshot()
    const files = encodeAsset(base.asset)
    const moved = { ...files[0], path: '.pocketctl/knowledge/claims/renamed.yaml' }
    expect(decodeAsset([moved], base).path).toBe(moved.path)
    expect(() => decodeAsset([files[0], moved], base)).toThrow('duplicate_asset_id')
    expect(() => validateAssetPaths([base.asset, { ...base.asset, path: moved.path }])).toThrow('duplicate_asset_id')
  })
  it('hashes domain content independently from JSON whitespace but includes Markdown bytes', () => {
    const base = phase6Snapshot()
    const files = changeMetadata(encodeAsset(base.asset), () => {})
    expect(assetContentHash(decodeAsset(files, base))).toBe(assetContentHash(base.asset))
    const wiki = phase6Snapshot('wiki').asset
    const next = structuredClone(wiki) as any
    next.editable.pages[0].sections[1].markdown = next.editable.pages[0].sections[1].markdown.replaceAll('\r\n', '\n')
    expect(assetContentHash(next)).not.toBe(assetContentHash(wiki))
  })
})

describe('bounded strict JSON subset of YAML and repository paths', () => {
  it.each(['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":{"x":1,"x":2}}'])(
    'rejects duplicate JSON keys before overwriting: %s', raw => expect(() => parseStrictJson(Buffer.from(raw))).toThrow('duplicate_json_key'))
  it.each(['---\na: 1\n', '!!str hello', '{"x":NaN}', '{"x":1e999}', '\ufeff{}', '{} trailing', '{"x":"\\ud800"}', '{"x":9007199254740993}'])(
    'rejects unsupported or lossy input: %s', raw => expect(() => parseStrictJson(Buffer.from(raw))).toThrow())
  it('rejects invalid UTF-8 and excessive depth before domain parsing', () => {
    expect(() => parseStrictJson(Uint8Array.from([0xc3, 0x28]))).toThrow('invalid_utf8')
    expect(() => parseStrictJson(Buffer.from('['.repeat(33) + '0' + ']'.repeat(33)))).toThrow('document_too_deep')
  })
  const file = (path: string, mode = '100644', bytes: Uint8Array = Buffer.from('{}')) => ({ path, mode, bytes }) as RepositoryFile
  it.each(['/tmp/a', '../a', '.pocketctl/knowledge/../escape', '.pocketctl/knowledge/a\\b', '.pocketctl/knowledge/a\0b',
    '.pocketctl/knowledge/a\nb', '.pocketctl/knowledge//a', '.pocketctl/knowledge/.git/config', '.pocketctl/knowledge/a\u202eb',
    '.pocketctl/knowledge/' + 'x'.repeat(129), '.pocketctl/knowledge/' + Array(5).fill('文'.repeat(50)).join('/')])(
    'rejects unsafe path %s', path => expect(() => validateRepositoryFiles([file(path)])).toThrow())
  it.each(['120000', '160000', '100755'])('rejects Git mode %s', mode =>
    expect(() => validateRepositoryFiles([file('.pocketctl/knowledge/a', mode)])).toThrow('unsupported_file_mode'))
  it('rejects equivalent paths, LFS pointers, and file/run limits', () => {
    expect(() => validateRepositoryFiles([file('.pocketctl/knowledge/É'), file('.pocketctl/knowledge/e\u0301')])).toThrow('path_collision')
    expect(() => validateRepositoryFiles([file('.pocketctl/knowledge/a', '100644', Buffer.from('version https://git-lfs.github.com/spec/v1\n'))])).toThrow('lfs_pointer')
    expect(() => validateRepositoryFiles([file('.pocketctl/knowledge/a', '100644', new Uint8Array(262145))])).toThrow('file_too_large')
    expect(() => validateRepositoryFiles(Array.from({ length: 257 }, (_, i) => file(`.pocketctl/knowledge/${i}`)))).toThrow('too_many_files')
    expect(() => validateRepositoryFiles(Array.from({ length: 33 }, (_, i) => file(`.pocketctl/knowledge/${i}`, '100644', new Uint8Array(262144))))).toThrow('bundle_too_large')
  })
})
