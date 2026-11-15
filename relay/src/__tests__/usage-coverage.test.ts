import {it,expect} from 'vitest'
import {coverageState} from '../usage-analytics/coverage.js'
it('requires continuous evidence, never a heartbeat',()=>{expect(coverageState([],'2026-01-01','2026-01-03')).toBe('not_collected');expect(coverageState([{from_at:'2026-01-02',to_exclusive:'2026-01-03',state:'complete'}],'2026-01-01','2026-01-03')).toBe('partial')})
