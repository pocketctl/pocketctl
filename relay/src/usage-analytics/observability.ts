import { performance } from 'node:perf_hooks'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Counter, Histogram } from 'prom-client'
import { registry } from '../metrics.js'

const latency = new Histogram({
 name: 'pocketctl_personal_usage_latency_seconds',
 help: 'Personal usage latency by endpoint and stage',
 labelNames: ['endpoint','stage'] as const,
 buckets: [.001,.005,.025,.1,.25,.5,.8,1,1.5,2,3,5,8],
 registers: [registry],
})
const requests = new Counter({
 name: 'pocketctl_personal_usage_requests_total',
 help: 'Personal usage requests by endpoint, read path and outcome',
 labelNames: ['endpoint','history','outcome'] as const,
 registers: [registry],
})
type Phase = 'pool' | 'readiness' | 'authorization' | 'snapshot' | 'sql' | 'result' | 'serialization'
export class UsageTiming {
 readonly started=performance.now()
 readonly stages: Partial<Record<Phase,number>> = {}
 history = false
 outcome = 'ok'
 serializationStarted: number | undefined
 constructor(readonly endpoint: string, readonly range: string) {}
 add(phase: Phase, ms: number) {
  this.stages[phase]=(this.stages[phase]??0)+ms
 }
 async measure<T>(phase: Phase, fn: () => Promise<T>): Promise<T> {
  const start=performance.now()
  try{return await fn()}finally{this.add(phase,performance.now()-start)}
 }
}

const timings=new WeakMap<FastifyRequest,UsageTiming>()
export function startUsageTiming(req: FastifyRequest, reply: FastifyReply, endpoint: string) {
 const range=(req.query as {range?:unknown})?.range
 const timing=new UsageTiming(endpoint,typeof range==='string'&&['today','7d','14d','30d','all'].includes(range)?range:'default')
 timings.set(req,timing)
 reply.header('x-request-id',req.id)
 reply.raw.once('close',()=>{
  if(!reply.raw.writableFinished)finish(req,performance.now()-timing.started,499)
 })
 return timing
}
function finish(req: FastifyRequest, ms: number, status: number) {
  const timing=timings.get(req)
  if(!timing)return
  timings.delete(req)
  if(status===499)timing.outcome='client_aborted'
  latency.observe({endpoint:timing.endpoint,stage:'request'},ms/1000)
  for(const [stage,elapsed] of Object.entries(timing.stages))
   latency.observe({endpoint:timing.endpoint,stage},elapsed/1000)
  requests.inc({endpoint:timing.endpoint,history:String(timing.history),outcome:timing.outcome})
  if(ms>=2000||status===409||status>=500){
   const stages=Object.fromEntries(Object.entries(timing.stages).map(([key,value])=>[key,Math.round(value)]))
   console.info(JSON.stringify({event:'personal_usage_request',requestId:req.id,endpoint:timing.endpoint,
    range:timing.range,history:timing.history,status,outcome:timing.outcome,ms:Math.round(ms),stages}))
  }
 }
export function installUsageTimingHooks(app: FastifyInstance) {
 app.addHook('preSerialization',async(req,_reply,payload)=>{
  const timing=timings.get(req)
  if(timing)timing.serializationStarted=performance.now()
  return payload
 })
 app.addHook('onSend',async(req,_reply,payload)=>{
  const timing=timings.get(req)
  if(timing?.serializationStarted!==undefined)timing.add('serialization',performance.now()-timing.serializationStarted)
  return payload
 })
 app.addHook('onResponse',async(req,reply)=>finish(req,reply.elapsedTime,reply.statusCode))
 app.addHook('onRequestAbort',async(req)=>{
  const timing=timings.get(req)
  if(timing)finish(req,performance.now()-timing.started,499)
 })
}
