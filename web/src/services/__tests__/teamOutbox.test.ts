import {describe,test,expect} from 'vitest'
import {TeamContinuousCursor,IndexedDBTeamOutbox} from '../teamOutbox'
describe('Team continuous event position',()=>{
 test('receiving 10,12,12,11 cannot skip 11 or count duplicate 12',()=>{const cursor=new TeamContinuousCursor();cursor.reset(9);expect(cursor.receive(10)).toBe(10);expect(cursor.receive(12)).toBe(10);expect(cursor.receive(12)).toBe(10);expect(cursor.receive(11)).toBe(12)})
 test('server interval completion and retained resets preserve explicit boundaries',()=>{const cursor=new TeamContinuousCursor();cursor.receive(4);expect(cursor.completed(3)).toBe(4);cursor.reset(8);expect(cursor.value).toBe(8);expect(cursor.receive(10)).toBe(8);expect(cursor.completed(9)).toBe(10)})
 test('fails visibly when persistent storage is unavailable',async()=>{if(!globalThis.indexedDB)await expect(new IndexedDBTeamOutbox().list('scope')).rejects.toThrow('存储不可用')})
})
