import { validateRepositoryFiles } from './paths.js'
import type { RepositoryFile } from './types.js'

/** Bounded, uncompressed ZIP with UTF-8 names. Paths are validated before export. */
export function gitBundleZip(files:readonly RepositoryFile[]):Buffer {
  validateRepositoryFiles(files)
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0
  for(const file of files) {
    const name=Buffer.from(file.path),data=Buffer.from(file.bytes)
    let crc=0xffffffff
    for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
    crc=(crc^0xffffffff)>>>0
    const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6)
    h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(name.length,26)
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8)
    c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42)
    local.push(h,name,data);central.push(c,name);offset+=h.length+name.length+data.length
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16)
  return Buffer.concat([...local,directory,end])
}
