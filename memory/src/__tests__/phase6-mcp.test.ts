import { describe,expect,test } from 'vitest'
import { registerMemoryTools } from '../mcp/tools.js'
import type { McpServer } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'

function catalog(v2=true) {
  const handlers=new Map<string,{definition:any;call:(args:any)=>Promise<any>}>(),installationId=randomUUID()
  const grant={installationId,primaryInstallationId:installationId,version:'v2',scopeBindings:[],configVersion:'1',services:['memory.mcp'],callerType:'web'}
  registerMemoryTools({registerTool:(name:string,definition:any,call:any)=>handlers.set(name,{definition,call})} as unknown as McpServer,{
    pool:{} as never,grant:()=>v2?grant as never:{installationId,configVersion:'1',services:['memory.mcp'],callerType:'web'},sharedScopesEnabled:true,cursorSigningKey:'fixture',recallEmbeddingTimeoutMs:10,
  })
  return handlers
}
describe('Phase 6 read-only MCP surface',()=>{
  test('only status and diff are registered with strict bounded schemas and read-only annotations',()=>{
    const tools=catalog(),names=[...tools.keys()].filter(n=>n.startsWith('memory_git_'))
    expect(names).toEqual(['memory_git_status','memory_git_diff'])
    const definition=tools.get('memory_git_diff')!.definition
    expect(definition.annotations.readOnlyHint).toBe(true)
    expect(definition.inputSchema.safeParse({proposal_id:randomUUID(),grant:{},apply:true}).success).toBe(false)
    expect(tools.get('memory_git_status')!.definition.inputSchema.safeParse({limit:51}).success).toBe(false)
    const status=tools.get('memory_git_status')!.definition.inputSchema
    expect(status.safeParse({connection_id:randomUUID(),list:'proposals',limit:20}).success).toBe(true)
    expect(status.safeParse({connection_id:randomUUID()}).success).toBe(false)
    expect(status.safeParse({run_id:randomUUID(),connection_id:randomUUID(),list:'cleanup'}).success).toBe(false)
  })
  test('disabled service produces an explicit error instead of an empty status list',async()=>{
    const result=await catalog().get('memory_git_status')!.call({})
    expect(result.isError).toBe(true);expect(JSON.parse(result.content[0].text)).toEqual({error:{code:'feature_disabled'}})
  })
  test('v1 grant cannot access Git scope through a read-only tool',async()=>{
    const result=await catalog(false).get('memory_git_diff')!.call({proposal_id:randomUUID()})
    expect(result.isError).toBe(true);expect(JSON.parse(result.content[0].text)).toEqual({error:{code:'forbidden'}})
  })
})
