import { teamRequest, TeamApiError, type TeamRequestIdentity } from './teamClient'
import type { TaskDelivery, DeliveryDecision, DeliveryReminder, DeliveryExecution, DeliveryArtifact, DeliveryManagement, DeliverySpecRevision, DeliveryExecute, SessionDeliveryCards } from '../types/teamDelivery'
const base = (id: string, attempt?:string) => `/api/team/tasks/${encodeURIComponent(id)}${attempt?`/attempts/${encodeURIComponent(attempt)}`:''}/delivery`
export const getTaskDelivery = (id: string, attempt?:string) => teamRequest<TaskDelivery>(base(id,attempt))
export const getDeliveryCapabilities = (team: string) => teamRequest<{ writes_enabled: boolean }>(`/api/team/teams/${encodeURIComponent(team)}/delivery-capabilities`)
export const decideTaskDelivery = (id: string, input: DeliveryDecision, identity?:TeamRequestIdentity, attempt?:string) => teamRequest<{ decision_id: string; revision: number }>(`${base(id,attempt)}/decisions`, { method: 'POST', body: { ...input }, timeoutMs: 30000, identity })
export const getDeliveryReceipt = (id: string, key: string, identity?:TeamRequestIdentity, attempt?:string) => teamRequest<unknown>(`${base(id,attempt)}/receipt-lookup/${encodeURIComponent(key)}`,{identity,timeoutMs:15000})
export const getDeliveryHistory = (id: string, attempt?:string) => teamRequest<{ executions: DeliveryExecution[]; has_more: boolean }>(`${base(id,attempt)}/executions`)
export async function listDeliveryInbox():Promise<{items:DeliveryReminder[]}> {
  try { return await teamRequest('/api/team/delivery-inbox?include_steps=true') }
  catch(error) {
    if(error instanceof TeamApiError && error.status===400 && error.code==='invalid_request') return teamRequest('/api/team/delivery-inbox')
    throw error
  }
}
export const markDeliverySeen = (id: string) => teamRequest(`/api/team/delivery-inbox/${encodeURIComponent(id)}/seen`, { method: 'POST', body: {} })
export async function readDeliveryArtifact(task: string, submission: string, artifact: DeliveryArtifact, attempt?:string): Promise<Blob> {
  const bytes = await teamRequest<Blob>(`${base(task,attempt)}/submissions/${encodeURIComponent(submission)}/artifacts/${encodeURIComponent(artifact.id)}`, { responseType: 'blob' })
  const digest = await crypto.subtle.digest('SHA-256', await bytes.arrayBuffer())
  const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('')
  if (bytes.size !== artifact.byte_size || hash !== artifact.sha256) throw new TeamApiError(409, { error: { code: 'artifact_integrity', message: '文件校验失败，请重新读取' } })
  return bytes
}

export const getDeliveryManagement = (id:string) => teamRequest<DeliveryManagement>(`${base(id)}/management`)
export const reviseDeliverySpec = (id:string,input:DeliverySpecRevision,identity?:TeamRequestIdentity) => teamRequest(`${base(id)}/specs`,{method:'POST',body:{...input},timeoutMs:30000,identity})
export const executeDeliveryTask = (id:string,session:string,input:DeliveryExecute,identity?:TeamRequestIdentity) => teamRequest(`/api/team/sessions/${encodeURIComponent(session)}/tasks/${encodeURIComponent(id)}/execute`,{method:'POST',body:{...input},timeoutMs:30000,identity})

export const getSessionDeliveryCards = (session:string,after='') => teamRequest<SessionDeliveryCards>(`/api/team/sessions/${encodeURIComponent(session)}/delivery-cards${after?'?after='+encodeURIComponent(after):''}`,{timeoutMs:15000})

export async function readTrustedEvidence(task:string,evidence:import('../types/teamDelivery').TrustedDeliveryEvidence):Promise<string>{
 const bytes=await teamRequest<Blob>(`/api/team/tasks/${encodeURIComponent(task)}/trusted-evidence/${encodeURIComponent(evidence.evidence_id)}/report`,{responseType:'blob',timeoutMs:30000})
 if(bytes.size>2*1024*1024)throw new Error('验证报告超出读取限制。')
 const buffer=await bytes.arrayBuffer(),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(b=>b.toString(16).padStart(2,'0')).join('')
 if(hash!==evidence.report_sha256)throw new Error('验证报告校验失败，请刷新后重新读取。')
 return new TextDecoder('utf-8',{fatal:true}).decode(buffer)
}

export const revokeDeliveryArtifact = (task:string,submission:string,artifact:string,input:{request_id:string;expected_revision:number;reason:string},identity?:TeamRequestIdentity,attempt?:string) => teamRequest(`${base(task,attempt)}/submissions/${encodeURIComponent(submission)}/artifacts/${encodeURIComponent(artifact)}/revoke`,{method:'POST',body:{...input},timeoutMs:30000,identity})
