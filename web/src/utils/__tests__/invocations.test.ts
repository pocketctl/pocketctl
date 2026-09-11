import { describe, expect, it } from 'vitest'
import { searchInvocations, completeInvocation } from '../invocations'
import type { CommandItem } from '../../composables/useWebSocket'
const item = (name: string,id=name): CommandItem => ({id,name,source:'project',kind:'skill',description:'检查登录'})
describe('unified invocation completion',()=>{
 it('searches beyond 50 entries and matches substrings/descriptions',()=>{const items=Array.from({length:120},(_,i)=>item(`skill-${i}`));expect(searchInvocations(items,'/119')).toHaveLength(1);expect(searchInvocations(items,'/登录')).toHaveLength(120)})
 it('preserves duplicate names and ranks exact matches first',()=>{const items=[item('review-code'),item('review','a'),item('review','b')];expect(searchInvocations(items,'/review task').map(x=>x.id)).toEqual(['a','b','review-code'])})
 it('completes only name and retains the task text',()=>{expect(completeInvocation(item('review'),'/rev 检查这次修改')).toBe('/review 检查这次修改');expect(completeInvocation(item('review'),'/')).toBe('/review ');expect(searchInvocations([], 'normal /review')).toEqual([])})
})
