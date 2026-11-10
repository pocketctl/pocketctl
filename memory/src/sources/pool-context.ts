import type pg from 'pg'
import type {ArchiveReadStorage,ArchiveLimits} from '@pocketctl/session-source'
export interface SourcePoolContext {namespace:'public'|'memory';readerObserver?:(operation:string,kind:string,reason:string)=>void;archive?:{storage:ArchiveReadStorage;limits:ArchiveLimits}}
const contexts=new WeakMap<object,SourcePoolContext>()
const aliases=new WeakMap<object,object>()
// Factory-owned identity is deliberately separate from inherited context.
// PoolClient also exposes connect(); neither that method nor an alias proves
// ownership of a physical pool whose connection may be borrowed here.
const physicalPools=new WeakSet<pg.Pool>()
export function registerPhysicalSourcePool(pool:pg.Pool):void{physicalPools.add(pool)}
export const isPhysicalSourcePool=(db:pg.Pool):boolean=>physicalPools.has(db)&&sourceConnectionKey(db)===db&&sourcePoolContext(db).namespace==='memory'
export const sourceConnectionKey=(db:object):object=>aliases.get(db)??db
export function bindSourceConnectionAlias(alias:object,client:object):void{aliases.set(alias,sourceConnectionKey(client))}
export const sourcePoolContext=(db:object):SourcePoolContext=>contexts.get(db)??contexts.get(sourceConnectionKey(db))??{namespace:'public'}
export function bindSourcePool(db:object,context:SourcePoolContext):void {contexts.set(db,context)}
export function inheritSourcePool(client:pg.PoolClient,pool:pg.Pool):void{bindSourcePool(client,sourcePoolContext(pool))}
