import type { PortableAsset, RepositoryFile } from './types.js'

export const KNOWLEDGE_ROOT = '.pocketctl/knowledge'
export const GIT_INPUT_LIMITS = Object.freeze({ maxFiles: 256, maxFileBytes: 256 * 1024, maxTotalBytes: 8 * 1024 * 1024,
  maxDepth: 32, maxSegmentChars: 128, maxPathBytes: 512 })

export function validateRepositoryPath(path: string, root = KNOWLEDGE_ROOT): string {
  if (typeof path !== 'string' || path.startsWith('/') || /[\\\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(path)
    || /[\uD800-\uDFFF]/u.test(path) || Buffer.byteLength(path, 'utf8') > GIT_INPUT_LIMITS.maxPathBytes) throw new Error('invalid_path')
  const segments = path.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git'
    || [...segment].length > GIT_INPUT_LIMITS.maxSegmentChars || segment.endsWith('.') || segment.endsWith(' '))) throw new Error('invalid_path')
  if (!path.startsWith(`${root}/`)) throw new Error('outside_bound_root')
  return path.normalize('NFC').toLowerCase()
}

/** Inputs are already validated NFC/lowercase paths. A file also occupies each
 * ancestor directory; segment boundaries keep similarly prefixed siblings valid. */
export function normalizedPathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/** Operates on tree/blob data only; never checks out paths or follows symlinks. */
export function validateRepositoryFiles(files: readonly RepositoryFile[], root = KNOWLEDGE_ROOT): void {
  if (files.length > GIT_INPUT_LIMITS.maxFiles) throw new Error('too_many_files')
  const paths = new Set<string>()
  let total = 0
  for (const file of files) {
    const normalized = validateRepositoryPath(file.path, root)
    if ([...paths].some(path => normalizedPathsOverlap(path, normalized))) throw new Error('path_collision')
    paths.add(normalized)
    if (file.mode !== '100644') throw new Error('unsupported_file_mode')
    if (!(file.bytes instanceof Uint8Array)) throw new Error('invalid_file_bytes')
    if (file.bytes.byteLength > GIT_INPUT_LIMITS.maxFileBytes) throw new Error('file_too_large')
    total += file.bytes.byteLength
    if (total > GIT_INPUT_LIMITS.maxTotalBytes) throw new Error('bundle_too_large')
    if (Buffer.from(file.bytes.subarray(0, 128)).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) throw new Error('lfs_pointer')
  }
}

export function validateAssetPaths(assets: readonly PortableAsset[], root = KNOWLEDGE_ROOT): void {
  const ids = new Set<string>(), paths = new Set<string>()
  for (const asset of assets) {
    const key = `${asset.key.kind}:${asset.key.id}`
    const normalized = validateRepositoryPath(asset.path, root)
    if (ids.has(key)) throw new Error('duplicate_asset_id')
    if ([...paths].some(path => normalizedPathsOverlap(path, normalized))) throw new Error('path_collision')
    ids.add(key); paths.add(normalized)
  }
}
