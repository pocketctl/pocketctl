import {teamRequest,type TeamRequestIdentity} from './teamClient'
export interface ExternalRecoveryView {
 call_id:string;team_session_id:string;provider:'agentteams';call_state:string
 can_query:boolean;can_retry_original:boolean
 operation:null|{request_id:string;action:'query'|'retry_original';state:'pending'|'done'|'expired';result:null|{state:string;remote_task_id:string|null};updated_at:string}
}
const path=(session:string,call:string)=>`/api/team/sessions/${encodeURIComponent(session)}/calls/${encodeURIComponent(call)}/external-recovery`
export const readExternalRecovery=(session:string,call:string,identity:TeamRequestIdentity)=>teamRequest<ExternalRecoveryView>(path(session,call),{identity,timeoutMs:15000})
export const requestExternalRecovery=(session:string,call:string,input:{request_id:string;action:'query'|'retry_original';expected_query_id?:string},identity:TeamRequestIdentity)=>teamRequest<ExternalRecoveryView>(path(session,call),{method:'POST',body:input,identity,timeoutMs:15000})
