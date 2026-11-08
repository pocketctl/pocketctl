import {expect,test} from 'vitest'
import {adaptTeamSource,buildTeamMemorySourceRecords,teamReaderProjectionKey} from '@pocketctl/session-source'
const at=new Date('2026-11-01T00:00:00Z')
function source(revision:number,bindingId='binding'){
 const record=buildTeamMemorySourceRecords({teamId:'team',teamSessionId:'session',callId:'call',contextVersion:1,binding:{id:bindingId,revision:1,installationId:'installation',ownerScopeKind:'team',ownerScopeId:'owner'},readers:[{userId:1,participantRevision:revision}],goal:{eventId:'goal',eventSeq:1,content:'goal',authorUserId:1,occurredAt:at},reply:{eventIds:['reply'],eventSeqs:[2],content:'reply',authorOfferId:'offer',occurredAt:at},outcome:{eventId:'outcome',eventSeq:3,status:'completed',occurredAt:at}})[0]
 const adapted=adaptTeamSource({source_kind:record.sourceKind,source_id:record.sourceId,session_id:record.sessionId,turn_id:String(record.payload.turn_id),event_type:record.eventType,recorded_at:record.occurredAt,classification:{},data:record.payload})!
 return {record,adapted}
}
test('native projection identity separates participant/binding epochs without changing the external wire ID',()=>{
 const a=source(1),b=source(2),c=source(1,'different-binding')
 expect(a.record.sourceId).toBe(b.record.sourceId);expect(a.record.sourceId).toBe(c.record.sourceId)
 expect(new Set([a,b,c].map(({record,adapted})=>teamReaderProjectionKey(record.sourceId,adapted.provenance))).size).toBe(3)
 const reordered=Object.fromEntries(Object.entries(a.adapted.provenance).reverse())
 expect(teamReaderProjectionKey(a.record.sourceId,reordered as never)).toBe(teamReaderProjectionKey(a.record.sourceId,a.adapted.provenance))
})
test('an incomplete or mismatched original projection proof cannot mint a typed key',()=>{
 const a=source(1)
 expect(()=>teamReaderProjectionKey(a.record.sourceId,{...a.adapted.provenance,reader_projection_id:'forged'})).toThrow('invalid_team_projection_proof')
 expect(()=>teamReaderProjectionKey('different-wire-id',a.adapted.provenance)).toThrow('invalid_team_projection_proof')
 expect(()=>teamReaderProjectionKey(a.record.sourceId,{...a.adapted.provenance,read_scope:{...a.adapted.provenance.read_scope,participant_revision:0}})).toThrow('invalid_team_projection_proof')
})
