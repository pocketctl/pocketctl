import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {defineComponent,h,ref} from 'vue'
import {mount,flushPromises} from '@vue/test-utils'
const api=vi.hoisted(()=>({get:vi.fn(),mutate:vi.fn(),receipt:vi.fn()}))
const storage=vi.hoisted(()=>({load:vi.fn(),reserve:vi.fn(),remove:vi.fn(),pending:null as any}))
vi.mock('../teamClient',async original=>({...await original<typeof import('../teamClient')>(),getTeamTask:api.get,mutateTeamTaskSelfHolder:api.mutate,findTeamTaskSelfHolder:api.receipt}))
vi.mock('../teamTaskHolderJournal',()=>({teamTaskHolderJournal:storage}))
const user=ref<{id:number}|null>({id:2})
vi.mock('../../composables/useAuth',()=>({useAuth:()=>({user})}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=> 'local'}))
vi.mock('../../composables/useLocale',()=>({useLocale:()=>({t:(key:string)=>key})}))
import {useTeamTaskHolder} from '../../composables/useTeamTaskHolder'
import {TeamApiError} from '../teamClient'
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v)),changed=vi.fn(),denied=vi.fn()
const task={id:'task',team_id:'team',creator_user_id:2,state:'open',title:'Goal',revision:1,holder_user_ids:[] as number[]}
const wrappers:ReturnType<typeof mount>[]=[]
async function render(){let m!:ReturnType<typeof useTeamTaskHolder>;const w=mount(defineComponent({setup(){m=useTeamTaskHolder({teamId:'team',taskId:'task',currentUserId:2,writesEnabled:true},changed,denied);return()=>h('div')}}));wrappers.push(w);await flushPromises();return {w,m}}
beforeEach(()=>{vi.resetAllMocks();user.value={id:2};storage.pending=null;vi.spyOn(navigator,'onLine','get').mockReturnValue(true)
 storage.load.mockImplementation(async()=>copy(storage.pending));storage.reserve.mockImplementation(async(_scope,op)=>{if(storage.pending)throw Error('occupied');storage.pending=copy(op)});storage.remove.mockImplementation(async()=>{storage.pending=null})
 api.get.mockResolvedValue(task)
 api.mutate.mockImplementation(async(_id,active,input)=>({...task,revision:input.expected_revision+1,holder_user_ids:active?[2]:[]}))
 api.receipt.mockImplementation(async(id,key)=>({task_id:id,actor_user_id:2,request_id:key,found:false,response:null}))
})
afterEach(()=>{for(const w of wrappers.splice(0))w.unmount();vi.restoreAllMocks()})
test('explicit confirmation persists exact request before any mutation',async()=>{
 const {m}=await render();m.prepare();expect(api.mutate).not.toHaveBeenCalled();const op=copy(m.confirmation.value!)
 await m.confirm();expect(storage.reserve).toHaveBeenCalledWith(expect.any(String),op);expect(api.mutate).toHaveBeenCalledWith('task',true,op.input,expect.any(Object));expect(storage.pending).toBeNull();expect(m.ready.value).toBe(false)
 expect(storage.reserve.mock.invocationCallOrder[0]).toBeLessThan(api.mutate.mock.invocationCallOrder[0])
})
test('storage failure blocks send',async()=>{
 const {m}=await render();storage.reserve.mockRejectedValueOnce(Error('storage'));m.prepare();await m.confirm();expect(api.mutate).not.toHaveBeenCalled();expect(m.canChange.value).toBe(false)
})
test('unknown result survives reopen and retry requires absent receipt and new confirmation',async()=>{
 const {m,w}=await render();api.mutate.mockRejectedValueOnce(Error('lost'));m.prepare();await m.confirm();const op=copy(storage.pending);w.unmount()
 const {m:next}=await render();expect(next.pending.value).toEqual(op);expect(next.canChange.value).toBe(false)
 next.retryConfirm.value=true;await next.retry();expect(api.mutate).toHaveBeenCalledTimes(1)
 await next.resolve();expect(next.missing.value).toBe(true);next.retryConfirm.value=true;await next.retry()
 expect(api.mutate.mock.calls[1][2]).toEqual(op.input);expect(storage.pending).toBeNull()
})
test('old successful claim receipt never substitutes current released task',async()=>{
 const {m}=await render();api.mutate.mockRejectedValueOnce(Error('lost'));m.prepare();await m.confirm();const op=copy(storage.pending)
 api.get.mockResolvedValueOnce({...task,revision:4,holder_user_ids:[]});await m.load()
 api.receipt.mockResolvedValueOnce({task_id:'task',actor_user_id:2,request_id:op.input.request_id,found:true,response:{...task,revision:2,holder_user_ids:[2]}})
 await m.resolve();expect(m.task.value?.revision).toBe(4);expect(m.held.value).toBe(false);expect(m.ready.value).toBe(false);expect(api.mutate).toHaveBeenCalledTimes(1);expect(storage.pending).toBeNull()
})
test('wrong actor and wrong action receipts preserve pending record',async()=>{
 const {m}=await render();api.mutate.mockRejectedValueOnce(Error('lost'));m.prepare();await m.confirm();const key=storage.pending.input.request_id
 for(const r of [{task_id:'task',actor_user_id:3,request_id:key,found:false,response:null},{task_id:'task',actor_user_id:2,request_id:key,found:true,response:{...task,revision:2,holder_user_ids:[]}}]){api.receipt.mockResolvedValueOnce(r);await m.resolve();expect(storage.pending).not.toBeNull();expect(m.missing.value).toBe(false)}
})
test('a fresh definitive CAS rejection requires reload without silently retrying',async()=>{
 const {m}=await render();api.mutate.mockRejectedValueOnce(new TeamApiError(409,{error:{code:'revision_conflict'}}));m.prepare();await m.confirm();expect(storage.pending).toBeNull();expect(m.canChange.value).toBe(false)
 api.get.mockResolvedValueOnce({...task,revision:5});await m.load();m.prepare();expect(m.confirmation.value?.input.expected_revision).toBe(5)
})
test('a rejection after an earlier unknown send does not clear the original request',async()=>{
 const {m}=await render();api.mutate.mockRejectedValueOnce(Error('lost'));m.prepare();await m.confirm();await m.resolve();m.retryConfirm.value=true
 api.mutate.mockRejectedValueOnce(new TeamApiError(409,{error:{code:'revision_conflict'}}));await m.retry();expect(storage.pending).not.toBeNull();expect(storage.remove).not.toHaveBeenCalled()
})
test('account switch hides task and preserves pending record on late success',async()=>{
 const {m}=await render();let finish!:(v:unknown)=>void;api.mutate.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));m.prepare();const sending=m.confirm();await flushPromises();user.value={id:3};finish({...task,revision:2,holder_user_ids:[2]});await sending
 expect(m.task.value).toBeNull();expect(storage.pending).not.toBeNull();expect(storage.remove).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled()
})
test('permission revocation clears the view but retains pending intent',async()=>{
 const {m}=await render();api.mutate.mockRejectedValueOnce(Error('lost'));m.prepare();await m.confirm()
 api.receipt.mockRejectedValueOnce(new TeamApiError(403,{error:{code:'team_access_denied'}}));await m.resolve();expect(m.task.value).toBeNull();expect(m.revoked.value).toBe(true);expect(storage.pending).not.toBeNull();expect(denied).toHaveBeenCalled()
})
test('offline invalidates confirmation and reconnect rechecks current holder',async()=>{
 const {m}=await render();m.prepare();vi.spyOn(navigator,'onLine','get').mockReturnValue(false);window.dispatchEvent(new Event('offline'));await m.confirm();expect(api.mutate).not.toHaveBeenCalled();expect(m.confirmation.value).toBeNull()
 api.get.mockResolvedValueOnce({...task,revision:3,holder_user_ids:[2]});vi.spyOn(navigator,'onLine','get').mockReturnValue(true);window.dispatchEvent(new Event('online'));await flushPromises();m.prepare();expect(m.confirmation.value?.active).toBe(false);expect(m.confirmation.value?.input.expected_revision).toBe(3)
})
test('rendered release control requires confirmation before persistence and send',async()=>{
 api.get.mockResolvedValue({...task,holder_user_ids:[2]})
 const {default:Panel}=await import('../../components/team/TeamTaskHolderPanel.vue')
 const w=mount(Panel,{props:{taskId:'task',teamId:'team',currentUserId:2,writesEnabled:true}});wrappers.push(w);await flushPromises()
 await w.get('[data-testid="holder-open"]').trigger('click');expect(api.mutate).not.toHaveBeenCalled();expect(w.text()).toContain('team.holder.release_confirm')
 await w.get('[data-testid="holder-confirm"]').trigger('click');await flushPromises();expect(api.mutate.mock.calls[0][1]).toBe(false);expect(w.emitted('changed')).toHaveLength(1)
})
