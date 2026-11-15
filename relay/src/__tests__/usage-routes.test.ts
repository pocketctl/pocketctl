import {it,expect} from 'vitest'
import {issueSnapshot,readSnapshot} from '../usage-analytics/snapshot.js'
import {parseObjectId,objectId} from '../usage-analytics/call-service.js'
import {parseRange} from '../usage-analytics/range.js'
process.env.PERSONAL_USAGE_SNAPSHOT_SECRET='isolated-test-stable-signing-key-32'
it('binds snapshot to actor,host,range and checks expiry',()=>{const s=issueSnapshot({actor:1,daemon:'d1',range:'all',as_of:'2026-11-14T12:00:00Z',revision:'4',authorization_revision:'1'});expect(readSnapshot(s,1,'d1','all').revision).toBe('4');expect(()=>readSnapshot(s,2,'d1','all')).toThrow();expect(()=>readSnapshot(s,1,'all','all')).toThrow();expect(()=>readSnapshot(s,1,'d1','today')).toThrow()})
it('MCP object identity isolates servers and classification',()=>{const a=objectId('mcp','read','a','mcp'),b=objectId('mcp','read','b','mcp');expect(a).not.toBe(b);expect(a.length).toBe(45);expect(parseObjectId(a)).toMatchObject({kind:'mcp'});expect(()=>parseObjectId('../../etc/passwd')).toThrow()})
it('rejects array and object range values',()=>{for(const r of [['all'],{toString:()=> 'all'},null,365])expect(()=>parseRange(r)).toThrow()})
