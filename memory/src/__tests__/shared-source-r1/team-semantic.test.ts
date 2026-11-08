import {expect,test} from 'vitest'
import {buildTeamMemorySourceRecords,buildAcceptedDeliveryMemorySourceRecords,adaptTeamSource,canonicalPayloadHash,type SourceScope,type SourceRoot,type ResolvedSourceBody} from '@pocketctl/session-source'
import {normalizeTeamSemanticBody,groupTeamSemanticFacts} from '../../sources/team-semantic.js'
const binding={id:'binding',revision:1,installationId:'10000000-0000-0000-0000-000000000001',ownerScopeKind:'team' as const,ownerScopeId:'20000000-0000-0000-0000-000000000001'}
const time=new Date('2026-11-01T00:00:00Z'),readers=[{userId:1,participantRevision:1},{userId:2,participantRevision:2}]
const input={teamId:'team',teamSessionId:'ts',callId:'call',contextVersion:0,binding,readers,goal:{eventId:'goal',eventSeq:1,content:'same goal',authorUserId:1,occurredAt:time},reply:{eventIds:['reply'],eventSeqs:[2],content:'same reply',authorOfferId:'offer',occurredAt:time},outcome:{eventId:'outcome',eventSeq:3,status:'completed',occurredAt:time}}
function normalized(delivery=false,change:Record<string,unknown>={}){
 const records=delivery?buildAcceptedDeliveryMemorySourceRecords({...input,taskId:'task',spec:{revision:1,goal:'accepted goal',acceptance:'criteria',authorUserId:1,createdAt:time},submission:{id:'30000000-0000-0000-0000-000000000001',version:1,summary:'accepted summary',manifestSha256:'a'.repeat(64),authorOfferId:'offer',publishedAt:time},decision:{id:'40000000-0000-0000-0000-000000000001',decision:'accepted',reviewerUserId:1,createdAt:time},...change}):buildTeamMemorySourceRecords({...input,...change})
 return records.map(record=>{
  const adapted=adaptTeamSource({source_kind:record.sourceKind,source_id:record.sourceId,session_id:record.sessionId,turn_id:String(record.payload.turn_id),event_type:record.eventType,recorded_at:record.occurredAt,classification:{},data:record.payload})!
  const p=adapted.provenance,s=p.read_scope
  const scope:SourceScope={installationId:s.target_installation_id,principalUserId:String(s.participant_user_id),ownerScopeKind:s.target_owner_scope_kind,ownerScopeId:s.target_owner_scope_id,authorizationRevision:'1',configVersion:'1',modeGeneration:'2',bindingRevision:String(s.team_memory_binding_revision),participantRevision:String(s.participant_revision)}
  const root:SourceRoot={kind:delivery?'team_delivery':'team_collaboration',key:delivery?record.sessionId:p.team_call_id}
  const body:ResolvedSourceBody={head:{kind:root.kind,canonicalKey:record.sourceId,rootKey:root.key,sessionKey:record.sessionId,turnKey:adapted.turnId,eventType:adapted.eventType,occurredAt:record.occurredAt.toISOString(),classification:adapted.classification,provenance:{state:'known',team:p},contentHash:canonicalPayloadHash(adapted.payload).toString('hex'),hashVersion:'canonical-json-sha256-v1',storage:'team'},payload:adapted.payload}
  return {scope,root,body,fact:normalizeTeamSemanticBody(scope,root,body)}
 })
}
test.each([false,true])('two readers keep six proofs and form three semantic roles, including distinct reader Sessions (%s)',delivery=>{
 const entries=normalized(delivery),groups=groupTeamSemanticFacts(entries.map(e=>e.fact))
 expect(new Set(entries.map(e=>e.body.head.canonicalKey)).size).toBe(6)
 expect(new Set(entries.map(e=>e.body.head.contentHash)).size).toBe(6)
 expect(new Set(entries.map(e=>e.body.head.sessionKey)).size).toBe(2)
 expect(groups).toHaveLength(3)
 expect(groups.every(g=>g.witnesses.length===2&&g.publishReady===false)).toBe(true)
 expect(new Set(groups.map(g=>g.semanticSessionId)).size).toBe(1)
 expect(new Set(groups.map(g=>g.semanticTurnId)).size).toBe(1)
 const reversed=groupTeamSemanticFacts([...entries].reverse().map(e=>e.fact))
 expect(reversed).toEqual(groups)
 const onlySecond=groupTeamSemanticFacts(entries.filter(e=>e.scope.principalUserId==='2').map(e=>e.fact))
 expect(onlySecond.map(g=>[g.semanticKey,g.businessDigest])).toEqual(groups.map(g=>[g.semanticKey,g.businessDigest]))
 expect(onlySecond.every(g=>g.witnesses[0].scope.principalUserId==='2')).toBe(true)
})
test('same role identity with a changed body or lineage is a conflict, never a text/hash join',()=>{
 const entries=normalized(),other=normalized(false,{reply:{...input.reply,content:'different reply'}})
 expect(()=>groupTeamSemanticFacts([...entries.map(e=>e.fact),...other.map(e=>e.fact)])).toThrow('team_semantic_conflict')
 const changedLineage=normalized(false,{reply:{...input.reply,eventIds:['different-native-event']}})
 expect(()=>groupTeamSemanticFacts([...entries.map(e=>e.fact),...changedLineage.map(e=>e.fact)])).toThrow('team_semantic_conflict')
 const anotherCall=normalized(false,{callId:'another-call'})
 expect(groupTeamSemanticFacts([...entries,...anotherCall].map(e=>e.fact))).toHaveLength(6)
 expect(groupTeamSemanticFacts([...entries,...normalized(true)].map(e=>e.fact))).toHaveLength(6)
})
test('installation/binding partitions stay separate, and proof/scope/hash mismatches cannot enter a group',()=>{
 const entries=normalized(),other=normalized(false,{binding:{...binding,installationId:'10000000-0000-0000-0000-000000000002'}})
 expect(groupTeamSemanticFacts([...entries,...other].map(e=>e.fact))).toHaveLength(6)
 const e=entries[0]
 expect(()=>normalizeTeamSemanticBody({...e.scope,principalUserId:'999'},e.root,e.body)).toThrow('team_semantic_proof_invalid')
 expect(()=>normalizeTeamSemanticBody(e.scope,e.root,{...e.body,payload:{text:'forged'}})).toThrow('team_semantic_proof_invalid')
 expect(()=>normalizeTeamSemanticBody(e.scope,{kind:'relay_event',key:e.root.key},e.body)).toThrow('team_semantic_proof_invalid')
 const unknown=structuredClone(e.body);unknown.head.provenance={state:'unknown'}
 expect(()=>normalizeTeamSemanticBody(e.scope,e.root,unknown)).toThrow('team_semantic_proof_invalid')
})

test.each([false,true])('personal receiver partition retains the complete canonical binding target tuple (%s)',delivery=>{
 const entry=normalized(delivery)[0],receiver={...entry.scope,installationId:'60000000-0000-0000-0000-000000000001',ownerScopeKind:'personal' as const,ownerScopeId:'60000000-0000-0000-0000-000000000001'}
 const group=groupTeamSemanticFacts([normalizeTeamSemanticBody(receiver,entry.root,entry.body)])[0]
 expect(group.witnesses[0].scope).toEqual(receiver)
 expect(group.witnesses[0].provenance).toEqual(entry.body.head.provenance)
 const second={...receiver,installationId:'60000000-0000-0000-0000-000000000002'}
 expect(groupTeamSemanticFacts([normalizeTeamSemanticBody(receiver,entry.root,entry.body),normalizeTeamSemanticBody(second,entry.root,entry.body)])).toHaveLength(2)
 expect(()=>normalizeTeamSemanticBody({...entry.scope,installationId:receiver.installationId},entry.root,entry.body)).toThrow('team_semantic_proof_invalid')
 for(const [key,value] of [['target_installation_id',{}],['target_installation_id','not-a-uuid'],['target_owner_scope_kind','future'],['target_owner_scope_kind',{}],['target_owner_scope_id',null],['target_owner_scope_id','20000000-0000-0000-0000-00000000000X']] as const){
  const body=structuredClone(entry.body),proof=body.head.provenance.team as any
  proof.read_scope[key]=value;(body.payload as any).team_source=proof;body.head.contentHash=canonicalPayloadHash(body.payload).toString('hex')
  expect(()=>normalizeTeamSemanticBody(receiver,entry.root,body)).toThrow('team_semantic_proof_invalid')
 }
})
