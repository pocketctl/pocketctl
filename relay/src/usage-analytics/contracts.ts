export type UsageRange='today'|'7d'|'14d'|'30d'|'all'
export type CoverageState='complete'|'partial'|'not_collected'|'unknown'
export type Granularity='day'|'week'|'month'
export interface Window {from:string;toExclusive:string;days:number}
export interface AuthorizedWindow {ownerUserId:number;daemonId:string;from:string;toExclusive:string}
export interface AuthorizedUsageScope {kind:'personal'|'team';actorUserId:number;windows:AuthorizedWindow[];authorizationRevision:string;daemons:{daemon_id:string;name:string;historical:boolean}[]}
// All quantities use decimal strings in personal-v1. Never coerce BIGINT to JS Number.
export interface TokenAmounts {input:string|null;output:string|null;cache_read:string|null;cache_create:string|null;total:string|null;requests:string|null}
export class UsageError extends Error {constructor(public code:string,public status=400){super(code)}}
