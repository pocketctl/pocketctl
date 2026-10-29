import {describe,expect,test,vi} from 'vitest'
import type pg from 'pg'
import {deliveryStagingCleanupEnabled,TeamDeliveryStagingCleanup} from '../team/delivery-staging-cleanup.js'

describe('delivery staging cleanup boundaries',()=>{
 test('defaults off and cannot enable without an explicit team scope',()=>{
  expect(deliveryStagingCleanupEnabled({},[])).toBe(false)
  expect(()=>deliveryStagingCleanupEnabled({TEAM_DELIVERY_STAGING_CLEANUP:'on'},[])).toThrow('explicit')
  expect(()=>deliveryStagingCleanupEnabled({TEAM_DELIVERY_STAGING_CLEANUP:'true'},['team'])).toThrow('off or on')
  expect(deliveryStagingCleanupEnabled({TEAM_DELIVERY_STAGING_CLEANUP:'on'},['team'])).toBe(true)
 })
 test('invalid scope or batch cannot execute and an empty scope never opens a connection',async()=>{
  const connect=vi.fn(),pool={connect} as unknown as pg.Pool
  expect(()=>new TeamDeliveryStagingCleanup(pool,['../all'])).toThrow('configuration')
  const gc=new TeamDeliveryStagingCleanup(pool,[])
  await expect(gc.runOnce(101)).rejects.toThrow('batch')
  await expect(gc.runOnce()).resolves.toEqual({submissions:0,artifacts:0,bytes:0})
  expect(connect).not.toHaveBeenCalled()
 })
})
