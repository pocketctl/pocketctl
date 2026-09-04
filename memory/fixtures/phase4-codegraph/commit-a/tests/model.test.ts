import { Repository, summarize } from '../src/core/model.js'
import { formatLabel } from '../src/utils/format.js'

describe('model', () => {
  it('counts added items', () => {
    const repository = new Repository()
    repository.add({ id: '1', title: 'First' })
    if (repository.count() !== 1) throw new Error('count mismatch')
  })

  it('summarizes', () => {
    if (summarize([]) !== '0 items') throw new Error('summary mismatch')
  })

  it('formats labels', () => {
    if (!formatLabel('t', 'new').includes('new')) throw new Error('label mismatch')
  })
})
