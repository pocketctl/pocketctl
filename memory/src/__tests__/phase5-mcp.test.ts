import { describe,expect,test,vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/server'
import { registerMemoryTools } from '../mcp/tools.js'
import { loadSkillConfig } from '../skills/config.js'

function tools(mode:'off'|'shadow'='off') {
  const registered=new Map<string,{definition:any;handler:(args:any)=>Promise<any>}>(),query=vi.fn()
  registerMemoryTools({registerTool:(name:string,definition:any,handler:any)=>registered.set(name,{definition,handler})} as unknown as McpServer,{
    pool:{query} as never,grant:()=>({installationId:'a',configVersion:'1',services:['memory.mcp'],callerType:'web'}),sharedScopesEnabled:false,
    recallEmbeddingTimeoutMs:50,cursorSigningKey:'test-key',skillContext:{globalMode:mode,sharedMode:mode,config:loadSkillConfig({MEMORY_SKILL_MODE:mode})},
  })
  return {registered,query}
}
describe('Phase5 MCP read-only tools',()=>{
  test('exactly three skill reads and strict bounded schemas',()=>{
    const {registered}=tools()
    expect([...registered.keys()].filter(x=>x.includes('skill'))).toEqual(['memory_list_skills','memory_get_skill','memory_resolve_skill'])
    const schema=registered.get('memory_list_skills')!.definition.inputSchema
    expect(schema.safeParse({limit:51}).success).toBe(false)
    expect(schema.safeParse({grant:{}}).success).toBe(false)
    expect(registered.has('memory_execute_skill')).toBe(false)
  })
  test('off is explicit error and does not query or mutate',async()=>{
    const {registered,query}=tools()
    for(const name of ['memory_list_skills','memory_get_skill','memory_resolve_skill']) {
      const result=await registered.get(name)!.handler({skill_id:crypto.randomUUID()})
      expect(result.isError).toBe(true);expect(JSON.parse(result.content[0].text)).toEqual({error:{code:'feature_disabled'}})
    }
    expect(query).not.toHaveBeenCalled()
  })
  test('v1 cannot silently obtain Skill scope access',async()=>{
    const {registered,query}=tools('shadow')
    expect((await registered.get('memory_get_skill')!.handler({skill_id:crypto.randomUUID()})).isError).toBe(true)
    expect(query).not.toHaveBeenCalled()
  })
})
