import Fastify from 'fastify'
import { describe, expect, test, vi } from 'vitest'
import { GitProjectError, parseGitProject } from '../team/git-projects.js'
import { registerGitProjectRoutes } from '../team/git-project-routes.js'

const input = { name: 'PocketCTL', repository_url: 'git@github.com:pocketctl/pocketctl.git', branch: 'main', request_id: 'create-project-1' }
describe('Git Ops project input', () => {
  test('normalizes copied SSH/HTTPS addresses without reading a repository', () => {
    expect(parseGitProject(input)).toEqual({ ...input, provider: 'github', repository_url: 'https://github.com/pocketctl/pocketctl' })
    expect(parseGitProject({ ...input, repository_url: 'https://gitee.com/owner/repo.git/', branch: 'release/v1' })).toMatchObject({ provider: 'gitee', repository_url: 'https://gitee.com/owner/repo', branch: 'release/v1' })
  })
  test.each(['http://github.com/owner/repo', 'https://github.com.evil.test/owner/repo', 'https://user:token@github.com/owner/repo', 'https://github.com/owner/repo?token=x', 'https://127.0.0.1/owner/repo', 'https://github.com/owner/repo/tree/main', 'file:///etc/passwd'])('rejects unsupported or credential-bearing URL %s', repository_url => {
    expect(() => parseGitProject({ ...input, repository_url })).toThrow(GitProjectError)
  })
  test.each(['../main', 'main.lock', 'feature//test', 'HEAD', '-option', 'feature@{1}', 'main\nnext'])('rejects invalid branch %s', branch => expect(() => parseGitProject({ ...input, branch })).toThrow(GitProjectError))
  test('rejects caller authority and credential fields', () => {
    for (const extra of [{ actor_user_id: 7 }, { access_token: 'secret' }, { setup: 'ready' }]) expect(() => parseGitProject({ ...input, ...extra })).toThrow(GitProjectError)
  })
})

function fixture(enabled = true) {
  const service = { list: vi.fn(async () => ({ teams: [], projects: [] })), create: vi.fn() }
  const app = Fastify()
  registerGitProjectRoutes(app, { service, enabled: () => enabled, getDatabaseReady: () => true, verifyAccessToken: async token => token === 'valid' ? { userId: 7 } : null })
  return { app, service }
}
describe('Git Ops project routes', () => {
  test('requires authentication and the existing feature gate', async () => {
    const { app, service } = fixture(false)
    expect((await app.inject({ url: '/api/team/git-projects' })).statusCode).toBe(401)
    expect((await app.inject({ url: '/api/team/git-projects', headers: { authorization: 'Bearer valid' } })).statusCode).toBe(503)
    expect(service.list).not.toHaveBeenCalled(); await app.close()
  })
  test('uses the authenticated actor and returns a real registration rather than a connected claim', async () => {
    const { app, service } = fixture()
    service.create.mockResolvedValue({ created: true, project: { id: 'project', setup: 'memory_required' } })
    const response = await app.inject({ method: 'POST', url: '/api/team/teams/ctm_example/git-projects', headers: { authorization: 'Bearer valid' }, payload: input })
    expect(response.statusCode).toBe(201)
    expect(response.json().project.setup).toBe('memory_required')
    expect(service.create).toHaveBeenCalledWith('ctm_example', 7, expect.objectContaining({ repository_url: 'https://github.com/pocketctl/pocketctl' }))
    await app.close()
  })
  test('does not leak internal errors', async () => {
    const { app, service } = fixture(); service.list.mockRejectedValue(new Error('private SQL and credentials'))
    const response = await app.inject({ url: '/api/team/git-projects', headers: { authorization: 'Bearer valid' } })
    expect(response.statusCode).toBe(500); expect(response.body).not.toContain('private SQL')
    await app.close()
  })
})
