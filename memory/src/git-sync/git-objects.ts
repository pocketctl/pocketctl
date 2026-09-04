import { createHash } from 'node:crypto'
import { GitReadError } from './provider.js'
export const gitObjectHash=(type:'blob'|'tree'|'commit',bytes:Uint8Array)=>createHash('sha1').update(`${type} ${bytes.byteLength}\0`).update(bytes).digest('hex')
export interface GitTreeEntry {path:string;mode:string;sha:string;type:string;size?:number}
export function gitTreeHash(entries:GitTreeEntry[]):string {
  interface Node {children:Map<string,Node>;entry?:GitTreeEntry}
  const root:Node={children:new Map()}
  if(entries.length>4096)throw new GitReadError('provider_unverifiable')
  for(const entry of entries){
    if(entry.type==='tree')continue
    if(!['100644','100755','120000','160000'].includes(entry.mode)||!/^[a-f0-9]{40}$/.test(entry.sha))throw new GitReadError('provider_unverifiable')
    let node=root
    for(const part of entry.path.split('/')){if(!part||part==='.'||part==='..'||/[\x00-\x1f\\]/.test(part)||node.entry)throw new GitReadError('provider_unverifiable')
      if(!node.children.has(part))node.children.set(part,{children:new Map()});node=node.children.get(part)!}
    if(node.entry||node.children.size)throw new GitReadError('provider_unverifiable');node.entry=entry
  }
  function hash(node:Node):string{return gitObjectHash('tree',Buffer.concat([...node.children.entries()]
    .sort(([an,a],[bn,b])=>Buffer.compare(Buffer.from(an+(a.entry?'':'/')),Buffer.from(bn+(b.entry?'':'/'))))
    .map(([name,n])=>Buffer.concat([Buffer.from(`${n.entry?n.entry.mode:'40000'} ${name}\0`),Buffer.from(n.entry?n.entry.sha:hash(n),'hex')]))))}
  return hash(root)
}
export function gitCommitHash(tree:string,parent:string,message:string,date:string):string {
  const identity=`PocketCtl Memory <memory@pocketctl.invalid> ${Math.floor(Date.parse(date)/1000)} +0000`
  return gitObjectHash('commit',Buffer.from(`tree ${tree}\nparent ${parent}\nauthor ${identity}\ncommitter ${identity}\n\n${message}\n`))
}
