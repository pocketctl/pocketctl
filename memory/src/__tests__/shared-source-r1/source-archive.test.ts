import {mkdtemp,mkdir,writeFile,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {expect,test} from 'vitest'
import {createSourceArchiveReader} from '../../sources/archive-reader.js'
const key='session-archive/v1/10000000-0000-0000-0000-000000000001/0.gz'
test('archive reader exposes read-only bounded streams and rejects key or filesystem escapes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'shared-archive-reader-'));await mkdir(join(root,'session-archive/v1/10000000-0000-0000-0000-000000000001'),{recursive:true});await writeFile(join(root,key),'encoded')
 const storage=createSourceArchiveReader(root,'test-archive',10)
 expect('put' in storage).toBe(false);expect('delete' in storage).toBe(false)
 let text='';for await(const chunk of await storage.read(key))text+=Buffer.from(chunk).toString();expect(text).toBe('encoded')
 await expect(storage.read('../other')).rejects.toThrow('invalid archive object key')
 await expect(createSourceArchiveReader(root,'test-archive',2).read(key)).rejects.toThrow('archive_size_limit')
 const outside=await mkdtemp(join(tmpdir(),'outside-archive-'));await writeFile(join(outside,'secret'),'secret')
 const linkRoot=await mkdtemp(join(tmpdir(),'linked-archive-'));await symlink(root,join(linkRoot,'root'))
 await expect(createSourceArchiveReader(join(linkRoot,'root'),'test-archive').read(key)).rejects.toThrow('archive_path_invalid')
})
test('archive configuration is an explicit pair carried into pool context without connecting',async()=>{
 const {loadMemoryConfig}=await import('../../config.js'),{createMemoryPool}=await import('../../db.js'),{sourcePoolContext}=await import('../../sources/pool-context.js')
 expect(()=>loadMemoryConfig({MEMORY_SHARED_ARCHIVE_DIRECTORY:'/tmp/archive'})).toThrow('source_archive_configuration_invalid')
 expect(()=>loadMemoryConfig({MEMORY_SHARED_ARCHIVE_DIRECTORY:'relative',MEMORY_SHARED_ARCHIVE_NAMESPACE:'test'})).toThrow('source_archive_configuration_invalid')
 const config=loadMemoryConfig({MEMORY_SHARED_ARCHIVE_DIRECTORY:'/tmp/archive',MEMORY_SHARED_ARCHIVE_NAMESPACE:'test'})
 expect(config.sourceArchive).toEqual({directory:'/tmp/archive',namespace:'test'})
 const pool=createMemoryPool({...config,databaseNamespace:'memory'});try{expect(sourcePoolContext(pool).archive?.storage.namespace).toBe('test')}finally{await pool.end()}
})
