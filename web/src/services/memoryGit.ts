import {scopedMemoryJson} from './memoryClient'
import type {MemoryGitExpected,MemoryGitPage,MemoryGitProposal,MemoryGitVersion,MemoryGitProposalPage,MemoryGitCleanupPage} from '../types/memoryGit'
const base='/api/v1/memory/git',id=encodeURIComponent
const read=<T>(scope:string,path:string,signal?:AbortSignal)=>scopedMemoryJson<T>(scope,'memory.search',base+path,{signal})
const write=<T>(scope:string,path:string,body:unknown,key:string,signal?:AbortSignal,method='POST')=>scopedMemoryJson<T>(scope,'memory.manage',base+path,{method,body:JSON.stringify(body),headers:{'idempotency-key':key},signal})
export interface GitProjectConnection {connection_id:string;repository_id:string;generation:string;state:string;target_branch:string;consent_until:string;authorized:boolean;repository_url:string}
export interface GitExportDownload {export_id:string;branch:string;base_commit:string;publishable:boolean;archive:{name:string;content:string}}
export const memoryGit={
  project:(scope:string,project:string,signal?:AbortSignal)=>read<{project:GitProjectConnection|null;can_configure:boolean;can_link_identity:boolean}>(scope,`/projects/${id(project)}`,signal),
  linkIdentity:(scope:string,project:string,body:{access_token:string;expected_generation:string},key:string)=>write<{project:GitProjectConnection}>(scope,`/projects/${id(project)}/identity`,body,key),
  connectProject:(scope:string,project:string,body:{project_id:string;repository_url:string;branch:string;access_token:string;read_consent:true;expected_generation:string|null},key:string)=>write<{project:GitProjectConnection}>(scope,`/projects/${id(project)}/connect`,body,key),
  disconnectProject:(scope:string,project:string,generation:string)=>write<{project:GitProjectConnection}>(scope,`/projects/${id(project)}/disconnect`,{expected_generation:generation},`disconnect-${globalThis.crypto.randomUUID()}`),
  assets:(scope:string,connection:string,signal?:AbortSignal)=>read<{items:Array<{kind:'claim'|'rule'|'wiki'|'skill';id:string;label:string}>}>(scope,`/connections/${id(connection)}/assets`,signal),
  export:(scope:string,connection:string,body:{expected_generation:string;assets:Array<{kind:'claim'|'rule'|'wiki'|'skill';id:string}>;reason_code:'manual_preview'|'review_change'},key:string,signal?:AbortSignal)=>write<{export_id:string}>(scope,`/connections/${id(connection)}/exports`,body,key,signal),
  bundle:(scope:string,exportId:string,signal?:AbortSignal)=>read<GitExportDownload>(scope,`/exports/${id(exportId)}/bundle`,signal),
  connections:(scope:string,cursor?:string,signal?:AbortSignal,connectionId?:string)=>read<MemoryGitPage>(scope,`/connections?${new URLSearchParams({limit:'20',...(cursor?{cursor}:{}),...(connectionId?{connection_id:connectionId}:{})})}`,signal),
  proposals:(scope:string,connection:string,cursor?:string,signal?:AbortSignal)=>read<MemoryGitProposalPage>(scope,`/connections/${id(connection)}/proposals?${new URLSearchParams({limit:'20',...(cursor?{cursor}:{})})}`,signal),
  cleanup:(scope:string,connection:string,cursor?:string,signal?:AbortSignal)=>read<MemoryGitCleanupPage>(scope,`/connections/${id(connection)}/cleanup?${new URLSearchParams({limit:'50',...(cursor?{cursor}:{})})}`,signal),
  proposal:(scope:string,proposal:string,signal?:AbortSignal)=>read<MemoryGitProposal>(scope,`/proposals/${id(proposal)}`,signal),
  run:(scope:string,run:string,signal?:AbortSignal)=>read<Record<string,unknown>>(scope,`/runs/${id(run)}`,signal),
  create:(scope:string,body:{repository_id:string;target_id:string;sync_mode:'off'|'shadow'|'enabled';write_mode:'off'|'shadow'},key:string,signal?:AbortSignal)=>write(scope,'/connections',body,key,signal),
  configure:(scope:string,connection:string,body:{expected_generation:string;sync_mode:'off'|'shadow'|'enabled';write_mode:'off'|'shadow';state:'active'|'disabled'},key:string,signal?:AbortSignal)=>write(scope,`/connections/${id(connection)}`,body,key,signal,'PUT'),
  preview:(scope:string,connection:string,body:{expected_generation:string;assets:Array<{kind:'claim'|'rule'|'wiki'|'skill';id:string}>;reason_code:'manual_preview'|'review_change'},key:string,signal?:AbortSignal)=>write<{export_id:string}>(scope,`/connections/${id(connection)}/previews`,body,key,signal),
  sync:(scope:string,connection:string,body:{expected_generation:string;export_id:string;action:'enroll'|'poll'|'recover'},key:string,signal?:AbortSignal)=>write(scope,`/connections/${id(connection)}/sync`,body,key,signal),
  review:(scope:string,proposal:string,body:MemoryGitExpected&{decision:'approve'|'request_changes'|'reject'},key:string,signal?:AbortSignal)=>write(scope,`/proposals/${id(proposal)}/reviews`,body,key,signal),
  apply:(scope:string,proposal:string,body:MemoryGitExpected,key:string,signal?:AbortSignal)=>write(scope,`/proposals/${id(proposal)}/apply`,body,key,signal),
  resolve:(scope:string,proposal:string,body:MemoryGitExpected&{expected_inputs:MemoryGitProposal['expected_inputs'];resolution:Pick<MemoryGitVersion,'path'|'deleted'|'editable'>},key:string,signal?:AbortSignal)=>write<MemoryGitProposal>(scope,`/proposals/${id(proposal)}/resolution`,body,key,signal,'PUT'),
}
