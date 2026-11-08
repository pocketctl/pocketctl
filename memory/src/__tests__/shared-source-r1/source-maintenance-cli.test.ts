import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {describe,expect,test} from 'vitest'
import {probeSystemdDrain,validateDrainEvidence} from '../../migrations/shared-forward/source-fence.js'
import {main,maintenanceHelp} from '../../migrations/shared-forward/source-maintenance-cli.js'
describe('administrator maintenance entrypoint',()=>{
 const units={api:'memory-api.service',worker:'memory-worker.service',freshInstall:false}
 test('reads both units via bounded injected systemd processes and refuses a live worker',async()=>{
  const calls:string[][]=[]
  const probe=await probeSystemdDrain(units,async(_file,args,options)=>{calls.push(args);expect(options.timeout).toBeLessThanOrEqual(5000);return {stdout:'LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\n'}})
  validateDrainEvidence(units,probe);expect(calls).toHaveLength(2)
  expect(()=>validateDrainEvidence(units,{...probe,worker:{...probe.worker,MainPID:'123'}})).toThrow('memory_service_not_drained')
  expect(()=>validateDrainEvidence(units,{...probe,worker:{...probe.worker,LoadState:'not-found'}})).toThrow('memory_service_not_drained')
  validateDrainEvidence({...units,freshInstall:true},{...probe,worker:{...probe.worker,LoadState:'not-found'}})
 })
 test('rejects process timeouts, malformed output and indistinguishable units',async()=>{
  await expect(probeSystemdDrain(units,async()=>{throw Error('timeout')})).rejects.toThrow('systemd_probe_failed')
  await expect(probeSystemdDrain(units,async()=>({stdout:'MainPID=0'}))).rejects.toThrow('invalid_systemd_evidence')
  await expect(probeSystemdDrain({...units,worker:units.api})).rejects.toThrow('invalid_memory_units')
 })
 test('explicit fresh install accepts systemd not-found exit metadata but ordinary installs refuse it',async()=>{
  const runner=async()=>{throw Object.assign(Error('systemctl'),{code:1,stdout:'LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n'})}
  await expect(probeSystemdDrain(units,runner)).rejects.toThrow('systemd_probe_failed')
  validateDrainEvidence({...units,freshInstall:true},await probeSystemdDrain({...units,freshInstall:true},runner))
 })
 test('process-backed injected systemd probes honor process timeout and complete both shows',async()=>{
  const run=promisify(execFile)
  const evidence=await probeSystemdDrain(units,async(_file,args,options)=>{expect(args.at(-1)).toMatch(/memory-(api|worker)\.service/);return run(process.execPath,['-e',"process.stdout.write('LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nMainPID=0\\n')"],options)})
  validateDrainEvidence(units,evidence)
  await expect(probeSystemdDrain(units,async(_file,_args,options)=>run(process.execPath,['-e','setTimeout(()=>{},1000)'],{...options,timeout:25}))).rejects.toThrow('systemd_probe_failed')
 })
 test('pure CLI imports expose exact prerequisite and forward-only help; invalid arguments cannot connect',async()=>{
  expect(maintenanceHelp).toContain('SHARED_MAINTENANCE_URL');expect(maintenanceHelp).toContain('forward repair');expect(maintenanceHelp).toContain('activation')
  expect(await main(['invalid'])).toBe(2)
 })
})
