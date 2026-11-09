import {constants} from 'node:fs'
import {lstat,open,realpath} from 'node:fs/promises'
import {isAbsolute,resolve,sep} from 'node:path'
import {Readable} from 'node:stream'
import {assertArchiveObjectKey,type ArchiveReadStorage} from '@pocketctl/session-source'
/** Read capability only: Memory never receives archive put/delete methods. */
export function createSourceArchiveReader(directory:string,namespace:string,maximum=16*1024*1024):ArchiveReadStorage {
 if(!isAbsolute(directory)||!namespace||namespace.length>512||!Number.isSafeInteger(maximum)||maximum<1||maximum>32*1024*1024)throw Error('source_archive_configuration_invalid')
 return {namespace,async read(key){
  assertArchiveObjectKey(key)
  if((await lstat(directory)).isSymbolicLink())throw Error('archive_path_invalid')
  const root=await realpath(directory),target=resolve(root,key)
  if(!target.startsWith(root+sep))throw Error('archive_path_invalid')
  let component=root
  for(const part of key.split('/').slice(0,-1)){component=resolve(component,part);if((await lstat(component)).isSymbolicLink())throw Error('archive_path_invalid')}
  const file=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{
   const stat=await file.stat();if(!stat.isFile()||stat.size>maximum)throw Error('archive_size_limit')
   const bytes=await file.readFile();if(bytes.length>maximum)throw Error('archive_size_limit')
   return Readable.from([bytes])
  }finally{await file.close()}
 }}
}
