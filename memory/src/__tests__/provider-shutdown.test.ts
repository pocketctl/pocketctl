import {describe,test,expect,vi} from 'vitest'
import {ProviderDrain,drainTextProvider,drainEmbeddingProvider} from '../model/provider-drain.js'
import {withTextProviderBudget} from '../model/provider-budget.js'
import {evaluateAutomation} from '../governance/automation-evaluator.js'
import type {PreparedAutomation} from '../governance/automation-repository.js'
import type {TextGenerator,ModelJsonResult} from '../ports/text-generator.js'

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve}}
const result={ok:true as const,value:{support:true,conflict:false,risk:'low'},usage:{model:'synthetic',inputTokens:7,outputTokens:3}}
const input={operation:'review_shadow' as const,requestKey:'review:synthetic',system:'s',document:{},schema:{},timeoutMs:1000,signal:new AbortController().signal}
const limits={key:'synthetic',maxRequests:2,maxInputTokens:10000,maxOutputTokens:100,maxOutputTokensPerRequest:20}
const prepared={subjectKind:'team',installationId:'synthetic',runId:'synthetic',policy:{model:'synthetic'},snapshot:{statement:'A fact',bundleVerified:true,evidence:[{excerpt:'Evidence'}]}} as unknown as PreparedAutomation

describe('production provider shutdown',()=>{
 test('drain includes original response and budget settlement after shutdown',async()=>{
  const drain=new ProviderDrain(),response=deferred<ModelJsonResult<unknown>>(),settlement=deferred<void>(),settling=deferred<void>()
  const reserve=vi.fn(async()=>({ok:true as const,reservationId:'r1'}))
  const provider=drainTextProvider(withTextProviderBudget({generateJson:()=>response.promise} as TextGenerator,{reserve,async settle(){settling.resolve();await settlement.promise}},limits),drain)!
  const pending=provider.generateJson(input)
  drain.close()
  expect(await drain.wait(0)).toMatchObject({drained:false,activeOriginal:1})
  response.resolve(result)
  await settling.promise
  expect(await drain.wait(0)).toMatchObject({drained:false,activeOriginal:1})
  await expect(provider.generateJson(input)).rejects.toThrow('provider_shutdown')
  expect(reserve).toHaveBeenCalledTimes(1)
  settlement.resolve()
  expect(await pending).toMatchObject({budgetReservationId:'r1',usage:result.usage})
  expect(await drain.wait(100)).toEqual({drained:true,activeOriginal:0,activeBusiness:0})
 })
 test('cancelled review remains in drain until its late usage callback finishes',async()=>{
  const drain=new ProviderDrain(),response=deferred<ModelJsonResult<unknown>>(),callback=deferred<void>(),callbackStarted=deferred<void>()
  const generate=vi.fn(()=>response.promise),controller=new AbortController()
  const provider=drainTextProvider({generateJson:generate} as TextGenerator,drain)!
  const decision=evaluateAutomation(prepared,{provider,drain,signal:controller.signal,onProviderUsage:async()=>{callbackStarted.resolve();await callback.promise}})
  await vi.waitFor(()=>expect(generate).toHaveBeenCalledTimes(1))
  controller.abort()
  expect(await decision).toMatchObject({recommendation:'deferred',reason:'aborted'})
  drain.close()
  response.resolve({...result,budgetReservationId:'r1'})
  await callbackStarted.promise
  expect(await drain.wait(0)).toEqual({drained:false,activeOriginal:0,activeBusiness:1})
  callback.resolve()
  expect(await drain.wait(100)).toEqual({drained:true,activeOriginal:0,activeBusiness:0})
 })
 test('late provider rejection releases tracking without an unhandled rejection',async()=>{
  const drain=new ProviderDrain(),provider=drainTextProvider({async generateJson(){throw Error('synthetic_failure')}} as TextGenerator,drain)!
  await expect(provider.generateJson(input)).rejects.toThrow('synthetic_failure')
  expect(await drain.wait(0)).toMatchObject({drained:true,activeOriginal:0})
 })
 test('embedding calls obey the same stop and response lifetime',async()=>{
  const drain=new ProviderDrain(),response=deferred<{vectors:number[][];tokens:number;model:string}>(),embed=vi.fn(()=>response.promise)
  const provider=drainEmbeddingProvider({dimensions:2,embed},drain)!
  const pending=provider.embed({operation:'recall_query',texts:['synthetic'],signal:input.signal})
  drain.close()
  expect(await drain.wait(0)).toMatchObject({drained:false,activeOriginal:1})
  await expect(provider.embed({operation:'recall_query',texts:['synthetic'],signal:input.signal})).rejects.toThrow('provider_shutdown')
  response.resolve({vectors:[[0,1]],tokens:1,model:'synthetic'})
  expect(await pending).toMatchObject({tokens:1})
  expect(embed).toHaveBeenCalledTimes(1)
  expect(await drain.wait(100)).toMatchObject({drained:true})
 })
 test('deadline reports outstanding work without forgetting it',async()=>{
  vi.useFakeTimers()
  try{
   const drain=new ProviderDrain(),response=deferred<void>()
   drain.run(()=>response.promise)
   const waiting=drain.wait(1000)
   await vi.advanceTimersByTimeAsync(1000)
   expect(await waiting).toEqual({drained:false,activeOriginal:1,activeBusiness:0})
   expect(vi.getTimerCount()).toBe(0)
   response.resolve()
   expect(await drain.wait(100)).toMatchObject({drained:true})
  }finally{vi.useRealTimers()}
 })
 test('wall clock correction cannot extend the shutdown deadline',async()=>{
  vi.useFakeTimers()
  const response=deferred<void>()
  try{
   const drain=new ProviderDrain();drain.run(()=>response.promise)
   let finished=false
   const pending=drain.wait(1000).then(outcome=>{finished=true;return outcome})
   vi.setSystemTime(Date.now()-3600000)
   await vi.advanceTimersByTimeAsync(1000)
   expect(finished).toBe(true)
   expect(await pending).toMatchObject({drained:false,activeOriginal:1})
  }finally{response.resolve();await Promise.resolve();vi.useRealTimers()}
 })
})
