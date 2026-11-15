import {describe,it,expect} from 'vitest'
import {mergeWindows,resolveTeamUsageScope,assertPersonalQuery,scopeIncludes} from '../usage-analytics/scope.js'
describe('usage authorization',()=>{
 it('rejects scope escalation',()=>{for(const key of ['user_id','team_id','member','scope','from','to','as_of'])expect(()=>assertPersonalQuery({[key]:'1'})).toThrow()})
 it('never enables team scope',()=>expect(()=>resolveTeamUsageScope()).toThrow('not_enabled'))
 it('merges overlapping windows without duplicating owners',()=>{const w=mergeWindows([{ownerUserId:1,daemonId:'a',from:'2026-01-01',toExclusive:'2026-01-05'},{ownerUserId:1,daemonId:'a',from:'2026-01-03',toExclusive:'2026-01-08'},{ownerUserId:2,daemonId:'b',from:'2026-01-01',toExclusive:'2026-01-08'}]);expect(w).toHaveLength(2);expect(scopeIncludes(w,1,'a','2026-01-07')).toBe(true);expect(scopeIncludes(w,2,'a','2026-01-07')).toBe(false);expect(scopeIncludes([],1,'a','2026-01-07')).toBe(false)})
})
