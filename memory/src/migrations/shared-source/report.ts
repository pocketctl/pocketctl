import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, lstat, rmdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex')
export function decimal(value: unknown): string {
  if (typeof value==='number' && (!Number.isSafeInteger(value) || value<0)) throw new Error('invalid_decimal')
  const text=String(value)
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error('invalid_decimal')
  return text
}
export const json = (value: unknown): string => JSON.stringify(value,(_key,v)=>typeof v==='bigint'?v.toString():v,2)+'\n'
/** Private staging directory + exclusive target reservation. A final directory
 * appears only after all files fsync. Interrupted reservations are removed. */
export class ReportBundle {
  private details?: FileHandle
  private closed=false
  private constructor(readonly target: string, private staging: string, private reservation: FileHandle) {}
  static async create(path: string): Promise<ReportBundle> {
    const target=resolve(path)
    const parent=await lstat(dirname(target))
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('invalid_report_parent')
    // Every cooperating writer reserves the same name; rename never targets an existing path.
    const reservation=await open(target+'.lock','wx',0o600)
    const staging=join(dirname(target),'.'+basename(target)+'.partial-'+randomUUID())
    try {
      if (await lstat(target).then(()=>true, e=>{if(e.code==='ENOENT')return false;throw e})) throw new Error('report_exists')
      await mkdir(staging,{mode:0o700})
      return new ReportBundle(target,staging,reservation)
    } catch (e) { await reservation.close(); await rm(target+'.lock',{force:true}); throw e }
  }
  async write(name: string, value: unknown): Promise<void> {
    if (this.closed || !/^[a-z][a-z0-9-]*\.json$/.test(name)) throw new Error('invalid_report_file')
    const file=await open(join(this.staging,name),'wx',0o600)
    try { await file.writeFile(json(value)); await file.sync() } finally { await file.close() }
  }
  async detail(value: unknown): Promise<void> {
    if (this.closed) throw new Error('report_closed')
    this.details ??= await open(join(this.staging,'mapping-details.ndjson'),'wx',0o600)
    await this.details.writeFile(JSON.stringify(value)+'\n')
  }
  async finish(): Promise<void> {
    if (this.closed) throw new Error('report_closed')
    await this.details?.sync(); await this.details?.close(); this.details=undefined
    // Reserve a final empty directory using mkdir (no overwrite, including noncooperating writers).
    await mkdir(this.target,{mode:0o700})
    try { await rename(this.staging,this.target) } catch (e) { await rmdir(this.target).catch(()=>undefined); throw e }
    this.closed=true
    await this.reservation.close(); await rm(this.target+'.lock',{force:true})
  }
  async abort(): Promise<void> {
    if(this.closed)return
    this.closed=true
    await this.details?.close().catch(()=>undefined)
    await rm(this.staging,{recursive:true,force:true})
    await this.reservation.close(); await rm(this.target+'.lock',{force:true})
  }
}
