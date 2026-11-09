/** Tracks original work before an abort race is exposed. Deadlines are results,
 * never false completion; a process-local registry is not a native mode fence. */
export class ProviderDrain {
 private readonly active=new Map<Promise<unknown>,'original'|'business'>()
 private accepting=true
 /** Stop new model calls; callbacks belonging to admitted work may still join. */
 close(){this.accepting=false}
 run<T>(work:()=>Promise<T>):Promise<T>{
  if(!this.accepting)return Promise.reject(new Error('provider_shutdown'))
  return this.track('original',Promise.resolve().then(work))
 }
 track<T>(kind:'original'|'business',promise:Promise<T>):Promise<T>{
  this.active.set(promise,kind)
  void promise.then(()=>this.active.delete(promise),()=>this.active.delete(promise))
  return promise
 }
 counts(){return {activeOriginal:[...this.active.values()].filter(v=>v==='original').length,activeBusiness:[...this.active.values()].filter(v=>v==='business').length}}
 async wait(deadlineMs:number){
  if(!Number.isSafeInteger(deadlineMs)||deadlineMs<0||deadlineMs>10000)throw Error('invalid_receipt_drain_deadline')
  const until=performance.now()+deadlineMs
  while(this.active.size&&performance.now()<until){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([Promise.allSettled([...this.active.keys()]),new Promise<void>(r=>{timer=setTimeout(r,Math.max(1,until-performance.now()))})])}finally{if(timer)clearTimeout(timer)}}
  return {drained:this.active.size===0,...this.counts()}
 }
}
import type {TextGenerator} from '../ports/text-generator.js'
import type {EmbeddingProvider} from '../ports/embedding-provider.js'


/** Wrap the complete budgeted call, including its settlement, before exposing
 * an abort race to a caller. No request or model result is retained here. */
export function drainTextProvider(provider:TextGenerator|undefined,drain:ProviderDrain):TextGenerator|undefined{
 if(!provider)return undefined
 return {generateJson:input=>drain.run(()=>provider.generateJson(input))}
}
export function drainEmbeddingProvider(provider:EmbeddingProvider|undefined,drain:ProviderDrain):EmbeddingProvider|undefined{
 if(!provider)return undefined
 return {dimensions:provider.dimensions,embed:input=>drain.run(()=>provider.embed(input))}
}
