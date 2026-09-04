import type pg from 'pg'
import { describe, expect, test, vi } from 'vitest'
import { createEpisodeRepository } from '../episodes/repository.js'

describe('episode repository job handler', () => {
  test('remains callable after the job worker stores it as a bare handler', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })                 // BEGIN
      .mockResolvedValueOnce({ rows: [{ local_status: 'ready' }] })  // fence check
      .mockResolvedValue({ rows: [] })                     // reads + COMMIT
    const release = vi.fn()
    const connect = vi.fn().mockResolvedValue({ query, release })
    const repository = createEpisodeRepository({ connect } as unknown as pg.Pool)
    const handler = repository.handleCompileEpisode

    await expect(handler({
      job_id: 'job-1',
      installation_id: '11111111-1111-1111-1111-111111111111',
      job_type: 'compile_episode',
      idempotency_key: 'compile_episode:turn-1',
      payload: {},
      attempts: 0,
      claim_epoch: 1,
    }, new AbortController().signal)).resolves.toBeUndefined()

    expect(connect).toHaveBeenCalled()
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM source_turns'), [
      '11111111-1111-1111-1111-111111111111',
      'turn-1',
    ])
    expect(query).toHaveBeenCalledWith('BEGIN')
    expect(query).toHaveBeenCalledWith('COMMIT')
    expect(release).toHaveBeenCalled()
  })
})
