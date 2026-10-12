import Fastify from 'fastify'
import {z} from 'zod'
import type pg from 'pg'
import type {McpServer} from '@modelcontextprotocol/server'
import {describe,expect,test} from 'vitest'
import {registerReadRoutes} from '../api/read-routes.js'
import {createCorsHostPolicy} from '../auth/cors-host-policy.js'
import {registerMemoryTools} from '../mcp/tools.js'
import {encodeFederatedCursor,resolveFederatedCursor} from '../retrieval/federated-search-service.js'
const id='11111111-1111-4111-8111-111111111111'
const appMetadata={scopeKind:'task',scopeKey:'turn-a',canonicalRepositoryKey:null,repositoryId:null,snapshotId:null,branch:null,status:'verified'}
const row={version_id:'22222222-2222-4222-8222-222222222222',claim_id:'33333333-3333-4333-8333-333333333333',claim_type:'test_invariant',statement:'Release invariant',scope_kind:'task',scope_key:'turn-a',valid_from:null,freshness_at:new Date('2026-01-01'),authority:'user_accepted',repository_id:null,repo_snapshot_id:null,branch:null,search_as_of:'2026-10-09T00:00:00.000Z',consumption_hold_reason:null,canonical_repository_key:null,applicability:appMetadata}
function pool(){return{query:async(sql:string,params:unknown[])=>{
 if(sql.includes('CROSS JOIN knowledge_claims'))return{rows:[row],rowCount:1}
 if(sql.includes('candidate_documents'))return{rows:(params[1] as string[]).map(version_id=>({version_id})),rowCount:1}
 return{rows:[],rowCount:0}
}} as unknown as pg.Pool}
const grant=()=>({installationId:id,services:['memory.search','memory.recall'],configVersion:'1',callerType:'web' as const})
describe('task applicability request context',()=>{
 test.each(['search','recall'])('REST %s accepts and actually applies task context',async method=>{
  const app=Fastify()
  registerReadRoutes(app,{pool:pool(),guard:{guard:async()=>grant()} as never,policy:createCorsHostPolicy({allowedHosts:['localhost'],allowedOrigins:[],isProduction:false}),recallEmbeddingTimeoutMs:50,cursorSigningKey:'task-rest-key'})
  try{
   const matching=await app.inject({method:'POST',url:'/api/v1/memory/'+method,payload:{query:'invariant',task_scope_key:'turn-a'}})
   expect(matching.statusCode).toBe(200)
   expect(matching.json()[method==='search'?'hits':'claims']).toHaveLength(1)
   const other=await app.inject({method:'POST',url:'/api/v1/memory/'+method,payload:{query:'invariant',task_scope_key:'turn-b'}})
   expect(other.statusCode).toBe(200)
   expect(other.json()[method==='search'?'hits':'claims']).toEqual([])
  }finally{await app.close()}
 })
 test.each(['search','recall'])('MCP %s schema and handler preserve task context',async method=>{
  const registered=new Map<string,{inputSchema:Record<string,z.ZodType>;handler:(args:unknown)=>Promise<{content:{text:string}[]}>}>()
  const server={registerTool(name:string,definition:{inputSchema:Record<string,z.ZodType>},handler:(args:unknown)=>Promise<{content:{text:string}[]}>){registered.set(name,{...definition,handler})}} as unknown as McpServer
  registerMemoryTools(server,{pool:pool(),grant,sharedScopesEnabled:false,recallEmbeddingTimeoutMs:50,cursorSigningKey:'task-mcp-key'})
  const tool=registered.get('memory_'+method)!
  const matching=z.strictObject(tool.inputSchema).safeParse({query:'invariant',task_scope_key:'turn-a'})
  expect(matching.success).toBe(true)
  if(!matching.success)return
  expect(JSON.parse((await tool.handler(matching.data)).content[0].text)[method==='search'?'hits':'claims']).toHaveLength(1)
  const other=z.strictObject(tool.inputSchema).parse({query:'invariant',task_scope_key:'turn-b'})
  expect(JSON.parse((await tool.handler(other)).content[0].text)[method==='search'?'hits':'claims']).toEqual([])
 })
 test('federated outer cursor also binds task while preserving absent/null task compatibility',()=>{
  const context={scopes:[],query:'invariant'},asOf=new Date('2026-10-09T00:00:00Z'),key='task-federated-key'
  const old=encodeFederatedCursor({offset:0,asOf,context,key})
  expect(encodeFederatedCursor({offset:0,asOf,context:{...context,taskScopeKey:null},key})).toBe(old)
  const cursor=encodeFederatedCursor({offset:0,asOf,context:{...context,taskScopeKey:'turn-a'},key})
  expect(()=>resolveFederatedCursor({cursor,context:{...context,taskScopeKey:'turn-b'},key})).toThrow('invalid federated cursor')
 })
})
