import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { webcrypto } from 'node:crypto'
import { useAuth } from '../useAuth'
import { personalReadCache } from '../../services/personalReadCache'
const auth = useAuth()
const user = {id:7,email:null,phone:null,display_name:'fixture'}
let keyCalls = 0
beforeEach(() => {
  localStorage.clear(); vi.stubGlobal('crypto',webcrypto); vi.stubGlobal('indexedDB',new IDBFactory())
  keyCalls=0
  vi.spyOn(globalThis,'fetch').mockImplementation(async input => {
    const path=String(input)
    if(path.endsWith('/cache-key')) {
      keyCalls++
      if(keyCalls===1) return Response.json({error:'expired'},{status:401})
      return Response.json({user_id:7,key:btoa('k'.repeat(32)),key_id:'test',expires_at:Date.now()+900000})
    }
    if(path.endsWith('/refresh')) return Response.json({user,access_token:'refreshed'})
    return Response.json({user,access_token:'initial'})
  })
})
afterEach(async () => { await auth.logout(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
test('cache-key 401 refreshes authentication without logging out a valid session', async () => {
  await auth.loginViaEmail('fixture@example.test','123456')
  await personalReadCache.read('sessions')
  expect(auth.user.value?.id).toBe(7)
  expect(auth.accessToken.value).toBe('refreshed')
  await personalReadCache.write('sessions',['secret'])
  expect(await personalReadCache.read('sessions')).toEqual(['secret'])
})
test('another tab changes account without this tab deleting the new profile or broadcasting again', async () => {
  await auth.loginViaEmail('fixture@example.test','123456')
  const profile=JSON.stringify({...user,id:8})
  localStorage.setItem('pocketctl_user',profile)
  const barrier=localStorage.getItem('pocketctl-personal-cache-invalidation')
  window.dispatchEvent(new StorageEvent('storage',{key:'pocketctl_user',newValue:profile}))
  expect(auth.user.value).toBeNull()
  expect(personalReadCache.ticket().scope).toBe('')
  expect(localStorage.getItem('pocketctl_user')).toBe(profile)
  expect(localStorage.getItem('pocketctl-personal-cache-invalidation')).toBe(barrier)
})
test('logout locks the cache synchronously before its HTTP response', async () => {
  await auth.loginViaEmail('fixture@example.test','123456')
  let finish!:()=>void
  vi.mocked(fetch).mockImplementationOnce(()=>new Promise(resolve=>{finish=()=>resolve(Response.json({ok:true}))}))
  const pending=auth.logout()
  expect(personalReadCache.ticket().scope).toBe('')
  finish(); await pending
  expect(auth.isLoggedIn.value).toBe(false)
})
test('a late login response cannot restore identity after logout', async () => {
  let finish!:(value:Response)=>void
  vi.mocked(fetch).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  const pending=auth.loginViaEmail('fixture@example.test','123456')
  await auth.logout()
  finish(Response.json({user,access_token:'late'})); await pending
  expect(auth.isLoggedIn.value).toBe(false)
  expect(personalReadCache.ticket().scope).toBe('')
})

test('offline logout intent prevents silent cookie restoration until explicit login', async () => {
  await auth.loginViaEmail('fixture@example.test','123456')
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
  await auth.logout()
  const calls=vi.mocked(fetch).mock.calls.length
  expect(await auth.doRefreshToken()).toBe(false)
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls)
  await auth.loginViaEmail('fixture@example.test','123456')
  expect(auth.isLoggedIn.value).toBe(true)
})
