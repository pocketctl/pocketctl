import { PostgresRelaySourceStore, SharedSourceReader, SourceUnavailableError,
  type ArchiveReadStorage,type ArchiveLimits,type SourceScope,type SourceRoot,type SourceVersion,type CurrentSourceState,type SourceSqlPool,
} from '@pocketctl/session-source'

// Only this reader substitutes the turn generation for the session content
// component. It inherits the ordinary scoped member, cold archive, hash, and
// byte validation on every page and every resolution.
export function dialogueGenerationReader(db:SourceSqlPool,archive:{storage:ArchiveReadStorage;limits:ArchiveLimits}|undefined,
  turn:string,generation:string){
  class DialogueStore extends PostgresRelaySourceStore{
    override async checkCurrent(scope:SourceScope,root:SourceRoot,expected?:SourceVersion){
      if(root.kind!=='relay_event')throw new SourceUnavailableError('source_kind_unsupported')
      const row=(await this.query('SELECT * FROM shared.memory_dialogue_version($1::jsonb,$2,$3)',[scope,root.key,turn])).rows[0]
      if(!row||!['current','revoked','changed','deleted'].includes(row.state))throw new SourceUnavailableError('source_store_unavailable')
      const version={content:row.content_revision,authorization:row.authorization_revision,storage:row.storage_revision}
      const changed=version.content!==generation || expected && (expected.storage!==version.storage||expected.authorization!==version.authorization||expected.content!==version.content)
      const state:CurrentSourceState=row.state==='current'&&changed?'changed':row.state
      return {version,state}
    }
  }
  return new SharedSourceReader(new DialogueStore(db,archive,turn))
}
