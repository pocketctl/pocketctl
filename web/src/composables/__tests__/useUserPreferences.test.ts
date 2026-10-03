import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { useUserPreferences } from '../useUserPreferences'
import { workspaceNotification } from '../../utils/workspaceNotifications'
const auth=vi.hoisted(()=>({user:{value:{id:1} as {id:number}|null},accessToken:{value:'token'},doRefreshToken:vi.fn(async()=>false)}))
vi.mock('../useAuth',()=>({useAuth:()=>auth}))
vi.mock('../useEnv',()=>({getRelayOrigin:()=>''}))
const locale=vi.hoisted(()=>({value:'zh' as 'zh'|'en'}))
vi.mock('../useLocale',()=>({useLocale:()=>({locale,setLocale:(value:'zh'|'en')=>{locale.value=value}})}))
const defaults={locale:'zh',theme:'system',notifications:{browser:false,completed:true,errors:true,daemon:true,updates:false}}
let values:any,revision:number
beforeEach(async()=>{
  auth.user.value=null;await useUserPreferences().load();auth.user.value={id:1};values=structuredClone(defaults);revision=1
  vi.stubGlobal('fetch',vi.fn(async(_url:string,options:any)=>{
    if(options.method==='PATCH'){
      const body=JSON.parse(options.body)
      if(body.expected_revision!==revision)return {ok:false,status:409,json:async()=>({preferences:structuredClone(values),revision})}
      values={...values,...body.preferences,notifications:{...values.notifications,...body.preferences.notifications}};revision++
    }
    return {ok:true,status:200,json:async()=>({preferences:structuredClone(values),revision})}
  }))
})
afterEach(()=>vi.unstubAllGlobals())
test('serializes rapid edits and retries only edited fields after cross-device conflict',async()=>{
 const store=useUserPreferences();await store.load()
 values.notifications.daemon=false;revision=2
 await Promise.all([store.save({locale:'en'}),store.save({notifications:{completed:false}})])
 expect(store.preferences.value).toMatchObject({locale:'en',notifications:{daemon:false,completed:false,errors:true}})
 expect(store.error.value).toBe('');expect(revision).toBe(4)
})
test('logout prevents an in-flight response from applying another account preferences',async()=>{
 let resolve!:(value:any)=>void
 vi.stubGlobal('fetch',vi.fn(()=>new Promise(done=>{resolve=done})))
 const store=useUserPreferences(),loading=store.load();await Promise.resolve()
 auth.user.value=null;const loggedOut=store.load()
 resolve({ok:true,status:200,json:async()=>({preferences:{...defaults,locale:'en'},revision:9})})
 await Promise.all([loading,loggedOut]);expect(store.loaded.value).toBe(false);expect(store.preferences.value.notifications.browser).toBe(false)
})
test('notification delivery respects each switch, replay and active session',()=>{
 const settings={...defaults.notifications,browser:true}
 const event={type:'session_status',session_id:'s',status:'completed'}
 expect(workspaceNotification(event,settings,'')).not.toBeNull()
 expect(workspaceNotification(event,{...settings,completed:false},'')).toBeNull()
 expect(workspaceNotification(event,settings,'s')).toBeNull()
 expect(workspaceNotification({...event,resync:true},settings,'')).toBeNull()
 expect(workspaceNotification({type:'daemon_status',daemon_id:'d',status:'offline'},{...settings,daemon:false},'')).toBeNull()
 expect(workspaceNotification({type:'turn_status',turn_status:'completed',session_id:'s',turn_id:'t'},settings,'')).not.toBeNull()
 expect(workspaceNotification({...event,is_subagent:true},settings,'')).toBeNull()
 expect(workspaceNotification({...event,status:'error'},{...settings,completed:false},'')).not.toBeNull()
})

test('first save preserves an existing browser appearance and locale', async () => {
 locale.value='en';localStorage.setItem('pocketctl-theme','dark')
 auth.user.value={id:9}
 const original=fetch
 vi.stubGlobal('fetch',vi.fn(async(url:any,options:any)=>{
   const response=await original(url,options)
   const data=await response.json()
   return {ok:true,status:200,json:async()=>({...data,configured:options.method==='PATCH'})} as Response
 }))
 const store=useUserPreferences();await store.load();await store.save({notifications:{completed:false}})
 expect(store.preferences.value).toMatchObject({locale:'en',theme:'dark',notifications:{completed:false}})
})
