import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { ExportBundle, RepositoryFile } from '../git-sync/types.js'
import type { GitReadCapability } from '../git-sync/provider.js'
import { validateRepositoryFiles } from '../git-sync/paths.js'

const execute = promisify(execFile)

/** Test-only filesystem/transport fixture. Only this mkdtemp repository receives
 * commits; imported repository content is data and never executable commands.
 * The actor supplied to readCapability is synthetic authenticated-test provenance,
 * never derived from a commit's untrusted name/email or claimed to be live proof. */
export async function createLocalGitFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pocketctl-phase6-roundtrip-'))
  const repository = join(root, 'repository'), empty = join(root, 'empty')
  await mkdir(repository)
  await mkdir(empty)
  // Allowlist deliberately drops every inherited GIT_* override (including
  // CONFIG_COUNT/PARAMETERS, template, worktree, index and credential settings).
  const env = { PATH: '/usr/bin:/bin', LC_ALL: 'C', TMPDIR: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Synthetic fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Synthetic fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
  async function git(...args: string[]): Promise<Buffer> {
    const result = await execute('/usr/bin/git', ['-c', `core.hooksPath=${empty}`, '-c', 'commit.gpgsign=false',
      '-c', 'tag.gpgsign=false', '-c', 'credential.helper=', '-c', 'protocol.allow=never', ...args],
    { cwd: repository, env, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })
    return result.stdout
  }
  const text = async (...args: string[]) => (await git(...args)).toString('utf8').trim()
  let merged: { mergeCommit: string; tree: string; parents: string[] } | undefined
  async function close() { await rm(root, { recursive: true, force: true }) }
  try {
    await git('init', '--initial-branch=main', `--template=${empty}`)
    await git('commit', '--allow-empty', '-m', 'Synthetic empty base')
    const baseCommit = await text('rev-parse', 'HEAD')
    return {
      baseCommit, close,
      remotes: async () => (await text('remote')).split('\n').filter(Boolean),
      async editAndMerge(bundle: ExportBundle) {
        validateRepositoryFiles(bundle.files)
        await git('switch', '-c', 'system-export')
        for (const file of bundle.files) {
          const target = join(repository, file.path)
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, file.bytes)
        }
        await git('add', '--', '.pocketctl')
        await git('commit', '-m', 'Synthetic system export')
        // Edit the actual serialized files as a person would, without calling
        // the codec to compute expected Markdown or editable field values.
        for (const file of bundle.files) {
          const target = join(repository, file.path)
          if (file.path.endsWith('/manifest.yaml') || !/\.(yaml|md)$/.test(file.path)) continue
          if (file.path.endsWith('.md')) {
            const content = await readFile(target, 'utf8')
            if (!content.includes('File summary')) throw new Error('fixture_wiki_paragraph_missing')
            await writeFile(target, content.replace('File summary', 'Local Git Wiki paragraph'))
          } else {
            const document = JSON.parse(await readFile(target, 'utf8'))
            if (document.key.kind === 'claim') document.editable.statement = 'Local Git claim revision'
            if (document.key.kind === 'rule') document.editable.statement = 'Local Git rule revision'
            if (document.key.kind === 'skill') document.editable.document.title = 'Local Git Skill draft'
            await writeFile(target, JSON.stringify(document, null, 2) + '\n')
          }
        }
        await git('add', '--', '.pocketctl')
        await git('commit', '-m', 'Synthetic human file edits')
        await git('switch', 'main')
        await git('merge', '--no-ff', 'system-export', '-m', 'Synthetic reviewed merge')
        merged = { mergeCommit: await text('rev-parse', 'HEAD'), tree: await text('rev-parse', 'HEAD^{tree}'),
          parents: (await text('show', '-s', '--format=%P', 'HEAD')).split(' ') }
        return merged
      },
      readCapability(exportId: string, actorId: string | null): GitReadCapability {
        if (!merged) throw new Error('fixture_not_merged')
        const merge = merged
        return { kind: 'fixture', target: { provider: 'github', providerRepositoryId: '123', branch: 'main', origin: 'https://api.github.com' },
          async request(request, signal) {
            signal.throwIfAborted()
            if (request.operation === 'merge') return { status: 200, body: { providerRepositoryId: '123', number: request.number,
              baseBranch: 'main', merged: true, mergeCommit: merge.mergeCommit, exportId, actorId } }
            if (request.operation === 'commit' && request.sha === merge.mergeCommit) return { status: 200,
              body: { sha: await text('rev-parse', 'HEAD'), tree: await text('rev-parse', 'HEAD^{tree}') } }
            if (request.operation === 'tree' && request.commit === merge.mergeCommit && request.tree === merge.tree && request.cursor === null) {
              const entries = (await git('ls-tree', '-r', '-z', merge.mergeCommit)).toString('utf8').split('\0').filter(Boolean)
              const files: RepositoryFile[] = []
              for (const entry of entries) {
                const match = /^(100644) blob ([a-f0-9]{40})\t(.+)$/.exec(entry)
                if (!match) throw new Error('fixture_tree_entry_invalid')
                files.push({ path: match[3], mode: '100644', bytes: await git('cat-file', 'blob', match[2]) })
              }
              signal.throwIfAborted()
              return { status: 200, body: { commit: merge.mergeCommit, tree: merge.tree, files, nextCursor: null } }
            }
            throw new Error('fixture_unexpected_read')
          } }
      },
    }
  } catch (error) { await close(); throw error }
}
