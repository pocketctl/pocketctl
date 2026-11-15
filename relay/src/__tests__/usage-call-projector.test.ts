import {it,expect} from 'vitest'
import {mergeCall,explicitSkill} from '../usage-analytics/call-projector.js'
it('merges lifecycle and late failure in original day',()=>{const a={hasStart:true,revision:0,outcome:'unknown',occurredAt:'2026-11-13T23:59:59Z'} as const;const b={hasStart:false,revision:1,outcome:'failure',occurredAt:'2026-11-14T00:00:01Z'} as const;expect(mergeCall(a,b)).toEqual({...a,revision:1,outcome:'failure'});expect(mergeCall(b,a).hasStart).toBe(true)})
it('never interprets read/list/mention as skill execution',()=>{for(const name of ['Read SKILL.md','Skill list','skill mention'])expect(explicitSkill({tool_name:name})).toBe(false);expect(explicitSkill({evidence_kind:'native_skill_execution',skill_key:'x',skill_name:'x'})).toBe(true)})
