export interface MemoryGitCapabilities {
  mode:'off'|'shadow'|'enabled';can_configure:boolean;can_preview:boolean;can_sync:boolean;can_review:boolean;can_resolve:boolean;can_apply:boolean;can_pull_request:false;external_write_reason:'external_write_disabled'
}
export interface MemoryGitConnection {
  connectionId:string;installationId:string;repositoryId:string;ownerScopeKind:'team'|'organization';ownerScopeId:string
  provider:'github'|'gitee'|'gitlab';providerRepositoryId:string;targetBranch:string;rootPath:string;syncMode:'off'|'shadow'|'enabled';writeMode:'off'|'shadow';state:'active'|'disabled';generation:string
  capabilities:MemoryGitCapabilities;last_success:string|null;current_error:string|null;cleanup_pending:boolean
  proposals_next_cursor:string|null;proposal_total:number;cleanup_next_cursor:string|null;cleanup_total:number;cleanup_pending_count:number
  exports:Array<{export_id:string;generation:string;base_commit:string;created_at:string}>
  proposals:Array<{proposal_id:string;revision:string;state:string;export_id:string}>
  runs:Array<{run_id:string;state:string;eligible:boolean;unfinished:boolean;failures:number;reason_code:string|null;updated_at:string}>
  cleanup:Array<{export_id:string;old_run_id:string;cleanup_pending:boolean;recognized_at:string|null}>
}
export interface MemoryGitVersion {key:{kind:string;id:string};revision:string;version_id:string;path:string;content_hash:string;source_digest:string;deleted:boolean;editable:unknown}
export interface MemoryGitProposal {
  proposal_id:string;connection_id:string;export_id:string;generation:string;revision:string;state:string;key:{kind:string;id:string};head_commit:string;proposed_hash:string;policy_hash:string;current_policy_hash:string
  expected_asset_revision:string;expected_inputs:{base:string;memory:string;git:string};versions:{base:MemoryGitVersion;memory:MemoryGitVersion;git:MemoryGitVersion}
  proposed_result:MemoryGitVersion|null
  conflicts:Array<{field:string;reason:string}>;gate_reasons:string[];review_reset:boolean;source:{kind:string;author_status:string};capabilities:MemoryGitCapabilities
}
export interface MemoryGitExpected {expected_generation:string;expected_revision:string;expected_policy_hash:string;expected_proposed_hash:string;expected_asset_revision:string}
export interface MemoryGitPage {items:MemoryGitConnection[];next_cursor:string|null}
export interface MemoryGitProposalPage {connection_id:string;generation:string;items:MemoryGitConnection['proposals'];next_cursor:string|null;total:number}
export interface MemoryGitCleanupPage {connection_id:string;generation:string;items:MemoryGitConnection['cleanup'];next_cursor:string|null;total:number;pending_count:number;cleanup_pending:boolean}
