import { decimal } from './report.js'
export interface CapacityInput {
  policy?:'forward-only'|'recoverable'
  existingAllocatedBytes?: string; freeBytes?: string; targetBytes?: string; stagingBytes?: string; temporaryIndexBytes?: string
  walBytes?: string; restoreBytes?: string; mappingBytes?: string; growthBytes?: string
  copySeconds?: string; indexSeconds?: string; restoreSeconds?: string; evidenceId?: string
}
export function capacityPlan(value: CapacityInput) {
  const policy=value.policy??'forward-only'
  if(policy!=='forward-only'&&policy!=='recoverable')throw new Error('invalid_capacity_policy')
  const components:('targetBytes'|'stagingBytes'|'temporaryIndexBytes'|'walBytes'|'restoreBytes'|'mappingBytes'|'growthBytes')[]=['targetBytes','stagingBytes','temporaryIndexBytes','walBytes','mappingBytes','growthBytes']
  if(policy==='recoverable')components.push('restoreBytes')
  const durations:('copySeconds'|'indexSeconds'|'restoreSeconds')[]=policy==='recoverable'?['copySeconds','indexSeconds','restoreSeconds']:['copySeconds','indexSeconds']
  const input:CapacityInput={}
  for(const k of [...components,'existingAllocatedBytes','freeBytes',...durations,'evidenceId'] as const)
    if(value[k]!==undefined)input[k]=value[k]

  const required=[...components,'existingAllocatedBytes','freeBytes',...durations] as const
  for(const key of required)if(input[key]!==undefined)decimal(input[key])
  const missing=required.filter(k=>input[k]===undefined).map(String)
  if(!input.evidenceId || !/^[a-zA-Z0-9._:-]{1,160}$/.test(input.evidenceId))missing.push('evidenceId')
  const peak=components.reduce((n,k)=>n+BigInt(input[k]??'0'),0n)
  const safety=(peak*30n+99n)/100n>2147483648n?(peak*30n+99n)/100n:2147483648n
  const requiredFree=peak+safety
  const ready=missing.length===0 && BigInt(input.freeBytes!)>=requiredFree
  return {schemaVersion:2,reportType:'capacity',policy,backupRequired:policy==='recoverable',rollbackSupported:policy==='recoverable',
    waivedChecks:policy==='forward-only'?['memory_backup','memory_restore','memory_rollback']:[],status:ready?'rehearsal-capacity-sufficient':'not-ready',ready,
    missing,components:input,peakAdditionalBytes:peak.toString(),safetyBytes:safety.toString(),requiredFreeBytes:requiredFree.toString(),
    existingAllocationIsAlreadyOnDisk:true,futureSavingsCreditedBytes:'0',migrationAuthorized:false,
    blockers:[...missing.map(k=>'measurement_missing:'+k),...(!missing.includes('freeBytes')&&BigInt(input.freeBytes!)<requiredFree?['insufficient_free_space']:[])],
  }
}
