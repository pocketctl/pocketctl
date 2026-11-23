import type pg from 'pg'
import {canonicalJsonString,type SourceRoot,type SourceScope,type SourceVersion} from '@pocketctl/session-source'
export interface SemanticContext {cursorKey:string;scope:SourceScope;mode:string;state:string;version:SourceVersion}
export interface SemanticRoot {outsidePartition:boolean;root:SourceRoot;seal:Record<string,unknown>;contexts:SemanticContext[]}
export interface TeamSemanticRoster {version:1;installationId:string;kind:'team_collaboration'|'team_delivery';seed:string;nativeKey:string;teamId:string;teamSessionId:string;callId:string;submissionId:string|null;decisionId:string|null;bindingId:string;bindingRevision:string;targetInstallationId:string;targetOwnerScopeKind:string;targetOwnerScopeId:string;publication:Record<string,unknown>;roots:SemanticRoot[];controlRevision:string;supportCount:number;withdrawn:boolean;admission:'eligible'|'before'|'unproven'|'denied'}
/** The DTO always comes from a bounded definer query, not a body/permission
 * envelope or a caller-selected list of positive witnesses. */
export async function discoverTeamSemanticGroup(pool:Pick<pg.Pool,'query'>,installation:string,root:SourceRoot):Promise<TeamSemanticRoster>{
 if(!['team_collaboration','team_delivery'].includes(root.kind))throw Error('team_semantic_group_request_invalid')
 const roster=(await pool.query('SELECT shared.read_memory_team_semantic_group($1,$2,$3) AS roster',[installation,root.kind,root.key])).rows[0]?.roster as TeamSemanticRoster
 if(!roster||roster.version!==1||roster.installationId!==installation||roster.kind!==root.kind||roster.seed!==root.key
  ||!Number.isSafeInteger(roster.supportCount)||roster.supportCount<0||typeof roster.withdrawn!=='boolean'
  ||!Array.isArray(roster.roots)||!roster.roots.length||roster.roots.length>256||roster.roots.flatMap(r=>r.contexts).length>512
  ||Buffer.byteLength(canonicalJsonString(roster))>2*1024*1024)throw Error('team_semantic_group_unproven')
 return roster
}
