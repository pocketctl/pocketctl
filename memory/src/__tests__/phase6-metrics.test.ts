import { describe,expect,test } from 'vitest'
import { Registry } from 'prom-client'

describe('Phase 6 finite provenance metrics',()=>{
  test('unmeasured durations have no zero sample and operational labels reject identities',async()=>{
    const {createPhase6Metrics}=await import('../metrics.js'),registry=new Registry(),metrics=createPhase6Metrics(registry)
    const empty=await registry.getMetricsAsJSON()
    expect(empty.filter(row=>row.name.includes('_duration_seconds_')||row.name.includes('_invalidation_seconds_')).flatMap(row=>row.values)).toEqual([])
    metrics.setOperational('request_rows',['repository-secret','responded'],1)
    metrics.setOperational('operational_rows',['proposal','repository-secret'],1)
    metrics.setOperational('operational_rows',['job','applied'],1)
    expect(await registry.metrics()).not.toContain('repository-secret')
    expect((await registry.getMetricsAsJSON()).find(row=>row.name==='pocketctl_memory_git_operational_rows')?.values).toEqual([])
  })
  test('unknown labels are rejected and failure/unfinished/partial remain separate denominator series',async()=>{
    const module=await import('../metrics.js')
    expect(module.createPhase6Metrics).toBeTypeOf('function')
    const registry=new Registry(),metrics=module.createPhase6Metrics(registry)
    metrics.setLedger('observation','unfinished','fixture',3)
    metrics.setLedger('canonical_change','failed','natural',2)
    metrics.setLedger('canonical_change','partial','shadow',1)
    metrics.setLedger('canonical_change','partial','repository-secret',10)
    metrics.setLedger('user-uuid','unfinished','natural',10)
    const output=await registry.metrics()
    expect(output).toContain('stage="observation",state="unfinished",provenance="fixture"} 3')
    expect(output).toContain('stage="canonical_change",state="failed",provenance="natural"} 2')
    expect(output).toContain('stage="canonical_change",state="partial",provenance="shadow"} 1')
    expect(output).not.toMatch(/repository-secret|user-uuid/)
  })
})
