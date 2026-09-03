import { z } from 'zod'
import { canonicalJsonString, canonicalPayloadHash } from '../inbox/canonical-json.js'
import { PortableAssetSchema, type AssetSnapshot, type PortableAsset, type RepositoryFile, type WikiAsset } from './types.js'
import { KNOWLEDGE_ROOT, validateAssetPaths, validateRepositoryFiles, validateRepositoryPath } from './paths.js'
import { assertJsonValue, decodeUtf8, parseStrictJson } from './strict-json.js'

export { parseStrictJson } from './strict-json.js'
const baselineFields = ['schemaVersion', 'key', 'connectionId', 'exportId', 'baseVersionId', 'baseRevision', 'sourceDigest', 'immutable'] as const
const wireFields = new Set<string>([...baselineFields, 'path', 'editable'])
const pageMarkerSchema = z.object({ assetId: z.uuid(), pageId: z.uuid() }).strict()
const sectionMarkerSchema = z.object({ sectionId: z.uuid(), sectionKey: z.string().min(1).max(128) }).strict()
const END_SECTION = '\n<!-- /pocketctl:section -->\n'
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const equal = (left: unknown, right: unknown) => canonicalJsonString(left) === canonicalJsonString(right)

function validateAsset(asset: PortableAsset): PortableAsset {
  assertJsonValue(asset)
  const parsed = PortableAssetSchema.parse(asset)
  validateAssetPaths([parsed])
  if (!parsed.path.endsWith('.yaml')) throw new Error('invalid_metadata_path')
  return parsed
}
function jsonBytes(value: unknown): Uint8Array {
  // Sorted keys, two-space JSON flow syntax, LF and no BOM. Array order matters.
  return Buffer.from(JSON.stringify(JSON.parse(canonicalJsonString(value)), null, 2) + '\n', 'utf8')
}
function file(path: string, bytes: Uint8Array): RepositoryFile { return { path, mode: '100644', bytes } }
function sectionMarker(section: { sectionId: string; sectionKey: string }): string {
  return `<!-- pocketctl:section ${JSON.stringify({ sectionId: section.sectionId, sectionKey: section.sectionKey })} -->\n`
}

export function encodeAsset(input: PortableAsset): RepositoryFile[] {
  const asset = validateAsset(input)
  const { serverOnly: _serverOnly, ...portable } = asset
  let files: RepositoryFile[]
  if (asset.key.kind !== 'wiki') files = [file(asset.path, jsonBytes(portable))]
  else {
    const wiki = asset as WikiAsset
    const directory = asset.path.slice(0, asset.path.lastIndexOf('/'))
    const editable = { pages: wiki.editable.pages.map(page => ({ ...page,
      sections: page.sections.map(({ markdown: _markdown, ...section }) => section) })) }
    files = [file(asset.path, jsonBytes({ ...portable, editable }))]
    wiki.editable.pages.forEach((page, index) => {
      const pageKey = wiki.immutable.pages[index].pageKey
      if (pageKey.includes('/')) throw new Error('invalid_page_key')
      const path = `${directory}/${pageKey}.md`
      validateRepositoryPath(path)
      let body = `<!-- pocketctl:page ${JSON.stringify({ assetId: asset.key.id, pageId: page.pageId })} -->\n`
      for (const section of page.sections) {
        if (/<!--\s*\/?pocketctl:/.test(section.markdown)) throw new Error('wiki_marker_invalid')
        body += sectionMarker(section) + section.markdown + END_SECTION
      }
      files.push(file(path, Buffer.from(body, 'utf8')))
    })
  }
  validateRepositoryFiles(files)
  return files
}

/** Patches may omit existing object fields; unknown fields stay present so the
 * final strict kind schema rejects them. Arrays are atomic except the explicitly
 * identity-bound Wiki page/section collections. */
function preserveOmitted(base: unknown, patch: unknown): unknown {
  if (!object(base) || !object(patch)) return patch
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(patch)])].map(key => [key,
    Object.hasOwn(patch, key) ? preserveOmitted(base[key], patch[key]) : structuredClone(base[key]),
  ]))
}
function mergeWikiMetadata(base: WikiAsset['editable'], raw: unknown): WikiAsset['editable'] {
  if (!object(raw)) throw new Error('invalid_editable')
  if (Array.isArray(raw.pages)) {
    for (const page of raw.pages) {
      if (object(page) && Array.isArray(page.sections) && page.sections.some(section => object(section) && Object.hasOwn(section, 'markdown'))) {
        throw new Error('wiki_duplicate_body')
      }
    }
  }
  const patched = preserveOmitted(base, raw) as WikiAsset['editable']
  if (!Array.isArray(patched.pages)) throw new Error('wiki_structure_invalid')
  patched.pages = patched.pages.map(page => {
    const prior = base.pages.find(candidate => candidate.pageId === page.pageId)
    if (!prior) throw new Error('wiki_structure_invalid')
    const next = preserveOmitted(prior, page) as typeof page
    if (!Array.isArray(next.sections)) throw new Error('wiki_structure_invalid')
    next.sections = next.sections.map(section => {
      const priorSection = prior.sections.find(candidate => candidate.sectionId === section.sectionId)
      if (!priorSection) throw new Error('wiki_structure_invalid')
      return preserveOmitted(priorSection, section) as typeof section
    })
    return next
  })
  return patched
}
function readWikiPages(files: RepositoryFile[], base: WikiAsset, editable: WikiAsset['editable']): void {
  const seen = new Set<string>()
  for (const current of files) {
    if (!current.path.endsWith('.md')) throw new Error('unmanaged_file')
    const text = decodeUtf8(current.bytes)
    const pageMatch = /^<!-- pocketctl:page (.+) -->\n/.exec(text)
    if (!pageMatch) throw new Error('wiki_marker_invalid')
    let pageMarker: z.infer<typeof pageMarkerSchema>
    try { pageMarker = pageMarkerSchema.parse(parseStrictJson(Buffer.from(pageMatch[1]))) }
    catch { throw new Error('wiki_marker_invalid') }
    if (pageMarker.assetId !== base.key.id) throw new Error('wiki_marker_invalid')
    if (seen.has(pageMarker.pageId)) throw new Error('duplicate_page_id')
    seen.add(pageMarker.pageId)
    const page = editable.pages.find(candidate => candidate.pageId === pageMarker.pageId)
    if (!page) throw new Error('wiki_marker_invalid')
    let cursor = pageMatch[0].length
    for (const section of page.sections) {
      const match = /^<!-- pocketctl:section (.+) -->\n/.exec(text.slice(cursor))
      if (!match) throw new Error('wiki_marker_invalid')
      let marker: z.infer<typeof sectionMarkerSchema>
      try { marker = sectionMarkerSchema.parse(parseStrictJson(Buffer.from(match[1]))) }
      catch { throw new Error('wiki_marker_invalid') }
      if (marker.sectionId !== section.sectionId || marker.sectionKey !== section.sectionKey) throw new Error('wiki_marker_invalid')
      cursor += match[0].length
      const end = text.indexOf(END_SECTION, cursor)
      if (end < 0) throw new Error('wiki_marker_invalid')
      const markdown = text.slice(cursor, end)
      if (/<!--\s*\/?pocketctl:/.test(markdown)) throw new Error('wiki_marker_invalid')
      section.markdown = markdown
      cursor = end + END_SECTION.length
    }
    if (cursor !== text.length) throw new Error('wiki_marker_invalid')
  }
  if (seen.size !== editable.pages.length) throw new Error('wiki_page_missing')
}

/** A successful decode is an untrusted edit proposal, never authorization or a
 * declaration that Evidence/permissions remain live. The caller must revalidate
 * those through current Ledger/Scope state before applying anything. */
export function decodeAsset(files: RepositoryFile[], snapshot: AssetSnapshot): PortableAsset {
  validateRepositoryFiles(files)
  if (snapshot.deleted) throw new Error('base_deleted')
  const base = validateAsset(snapshot.asset)
  const metadata = files.filter(current => current.path.endsWith('.yaml'))
  if (metadata.length === 0) throw new Error('asset_file_missing')
  const documents = metadata.map(current => ({ file: current, value: parseStrictJson(current.bytes) }))
  const matching = documents.filter(({ value }) => object(value) && equal(value.key, base.key))
  if (matching.length > 1) throw new Error('duplicate_asset_id')
  if (documents.length !== 1) throw new Error('unmanaged_file')
  const { file: metadataFile, value: raw } = documents[0]
  if (!object(raw)) throw new Error('invalid_asset_document')
  for (const field of baselineFields) if (!Object.hasOwn(raw, field) || !equal(raw[field], base[field])) throw new Error('immutable_field_changed')
  if (Object.keys(raw).some(key => !wireFields.has(key))) throw new Error('unknown_field')
  if (Object.hasOwn(raw, 'editable') && !object(raw.editable)) throw new Error('invalid_editable')
  if (raw.path !== undefined) {
    if (typeof raw.path !== 'string') throw new Error('invalid_path')
    validateRepositoryPath(raw.path, KNOWLEDGE_ROOT)
  }
  const proposed = { ...base, path: metadataFile.path,
    editable: preserveOmitted(base.editable, raw.editable ?? {}), serverOnly: structuredClone(base.serverOnly) }
  if (base.key.kind === 'wiki') {
    const wiki = base as WikiAsset
    const editable = mergeWikiMetadata(wiki.editable, raw.editable ?? {})
    readWikiPages(files.filter(current => current !== metadataFile), wiki, editable)
    proposed.editable = editable
  } else if (files.length !== 1) throw new Error('unmanaged_file')
  if (base.key.kind === 'skill') {
    const before = (base.editable as { document: { source_tokens: string[] } }).document.source_tokens
    const after = (proposed.editable as { document?: { source_tokens?: unknown } })?.document?.source_tokens
    if (!equal(before, after)) throw new Error('immutable_field_changed')
  }
  return validateAsset(proposed as PortableAsset)
}

/** Domain content hash is separate from raw-file signatures. JSON formatting,
 * export identity, storage paths and private server context do not mint versions;
 * Wiki Markdown content (including CRLF) remains significant. */
export function assetContentHash(input: PortableAsset): string {
  const asset = validateAsset(input)
  // Publication regenerates physical rows. Logical keys, array order and every
  // editable value remain significant; storage IDs are signed separately.
  const editable = asset.key.kind === 'wiki' ? { pages: (asset as WikiAsset).editable.pages.map((page, index) => ({
    pageKey: (asset as WikiAsset).immutable.pages[index].pageKey, title: page.title,
    sections: page.sections.map(({ sectionId: _sectionId, ...section }) => section),
  })) } : asset.editable
  return canonicalPayloadHash({ kind: asset.key.kind, editable }).toString('hex')
}
