import { expect, test } from 'vitest'
import { createNonOverlappingPoller } from '../non-overlapping-poller.js'

test('a slow pass is shared by concurrent ticks and stop drains it before refusing new work', async () => {
  let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve})
  let passes=0
  const poller=createNonOverlappingPoller(async()=>{passes++;await gate})
  const first=poller.runOnce()
  const second=poller.runOnce()
  expect(passes).toBe(1)
  let drained=false
  const stop=poller.stop().then(()=>{drained=true})
  await Promise.resolve()
  expect(drained).toBe(false)
  release()
  await Promise.all([first,second,stop])
  await poller.runOnce()
  expect(passes).toBe(1)
})

test('a failed pass releases the polling slot for recovery', async()=>{
  let passes=0
  const poller=createNonOverlappingPoller(async()=>{if(++passes===1)throw new Error('failed')})
  await expect(poller.runOnce()).rejects.toThrow('failed')
  await poller.runOnce()
  expect(passes).toBe(2)
})
