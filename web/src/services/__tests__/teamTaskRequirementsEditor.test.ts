import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {defineComponent,h,ref} from 'vue'
import {mount,flushPromises} from '@vue/test-utils'
const api=vi.hoisted(()=>({get:vi.fn(),history:vi.fn(),save:vi.fn(),override:vi.fn(),receipt:vi.fn()}))
const storage=vi.hoisted(()=>({load:vi.fn(),reserve:vi.fn(),remove:vi.fn(),pending:null as any}))
vi.mock('../teamClient',async original=>({...await original<typeof import('../teamClient')>(),getTeamTask:api.get,getTeamTaskRequirementHistory:api.history,saveTeamTaskRequirements:api.save,overrideTeamTaskRequirements:api.override,findTeamTaskRequirements:api.receipt}))
vi.mock('../teamTaskRequirementsJournal',()=>({teamTaskRequirementsJournal:storage}))
const user=ref<{id:number}|null>({id:2})
vi.mock('../../composables/useAuth',()=>({useAuth:()=>({user})}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=> 'local'}))
vi.mock('../../composables/useLocale',()=>({useLocale:()=>({t:(key:string)=>key})}))
import {useTeamTaskRequirements} from '../../composables/useTeamTaskRequirements'
import {TeamApiError} from '../teamClient'
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v)),changed=vi.fn(),denied=vi.fn()
const task={id:'task',team_id:'team',creator_user_id:2,state:'open',title:'Goal',revision:1}
const wrappers:ReturnType<typeof mount>[]=[]
async function render(){let m!:ReturnType<typeof useTeamTaskRequirements>;const w=mount(defineComponent({setup(){m=useTeamTaskRequirements({teamId:'team',taskId:'task',currentUserId:2,teamCreatorId:2,writesEnabled:true},changed,denied);return()=>h('div')}}));wrappers.push(w);await flushPromises();return {w,m}}
beforeEach(()=>{vi.resetAllMocks();user.value={id:2};storage.pending=null
 storage.load.mockImplementation(async()=>copy(storage.pending));storage.reserve.mockImplementation(async(_scope,op)=>{if(storage.pending)throw Error('occupied');storage.pending=copy(op)});storage.remove.mockImplementation(async()=>{storage.pending=null})
 api.get.mockResolvedValue(task);api.history.mockResolvedValue({events:[],next_before_revision:null})
 api.save.mockImplementation(async(_id,input)=>({...task,revision:input.expected_revision+1,requirements:{document:copy(input.requirements),revision:1,readiness:{status:'needs_information',missing:['scope','repository','acceptance']},override:null}}))
 api.receipt.mockImplementation(async(id,kind,key)=>({task_id:id,actor_user_id:2,kind,request_id:key,found:false,response:null}))
})
afterEach(()=>wrappers.splice(0).forEach(w=>w.unmount()))
test('confirmation cancel and edits send nothing; save reserves before sending and clears exact receipt',async()=>{
 const {m}=await render();m.prepare('save');m.confirmation.value=null;await m.save();expect(api.save).not.toHaveBeenCalled()
 m.prepare('save');m.draft.value.goal='Changed';expect(m.confirmation.value).toBeNull();await m.save();expect(api.save).not.toHaveBeenCalled()
 m.prepare('save');await m.save();expect(storage.reserve).toHaveBeenCalledTimes(1);expect(api.save).toHaveBeenCalledTimes(1);expect(storage.pending).toBeNull();expect(changed).toHaveBeenCalledTimes(1);expect(m.ready.value).toBe(false)
})
test('storage error prevents sending',async()=>{const {m}=await render();storage.reserve.mockRejectedValueOnce(Error('full'));m.prepare('save');await m.save();expect(api.save).not.toHaveBeenCalled();expect(m.error.value).toBe('full')})
test('unknown survives reopen; only confirmed absence permits retry of exact original request',async()=>{
 const {m,w}=await render();api.save.mockRejectedValueOnce(Error('lost'));m.prepare('save');await m.save();const op=copy(storage.pending);expect(op).not.toBeNull();w.unmount()
 const {m:next}=await render();expect(next.pending.value).toEqual(op);next.retryConfirm.value=true;await next.retry();expect(api.save).toHaveBeenCalledTimes(1)
 await next.resolve();expect(next.missing.value).toBe(true);next.retryConfirm.value=true;await next.retry();expect(api.save.mock.calls[1][1]).toEqual(op.input);expect(storage.pending).toBeNull()
})
test('account switch hides drafts and never deletes the original pending record on late response',async()=>{
 const {m}=await render();let finish!:(v:unknown)=>void;api.save.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));m.prepare('save');const sending=m.save();await flushPromises();user.value={id:3};finish({...task,revision:2});await sending
 expect(m.task.value).toBeNull();expect(m.draft.value.goal).toBe('');expect(storage.pending).not.toBeNull();expect(storage.remove).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled()
})
test('malformed or wrong actor receipt preserves unresolved operation',async()=>{
 const {m}=await render();api.save.mockRejectedValueOnce(Error('lost'));m.prepare('save');await m.save();api.receipt.mockResolvedValueOnce({task_id:'task',actor_user_id:3,kind:'save',request_id:storage.pending.input.request_id,found:false,response:null});await m.resolve();expect(m.missing.value).toBe(false);expect(storage.pending).not.toBeNull()
})
test('revoke removes protected view but preserves original intent',async()=>{
 const {m}=await render();api.save.mockRejectedValueOnce(Error('lost'));m.prepare('save');await m.save();api.receipt.mockRejectedValueOnce(new TeamApiError(403,{error:{code:'denied'}}));await m.resolve();expect(m.task.value).toBeNull();expect(m.revoked.value).toBe(true);expect(storage.pending).not.toBeNull();expect(denied).toHaveBeenCalledTimes(1)
})
test('found original receipt acknowledges without resending or reverting newer task state',async()=>{
 const {m}=await render();api.save.mockRejectedValueOnce(Error('lost'));m.prepare('save');await m.save();const op=copy(storage.pending)
 api.receipt.mockResolvedValueOnce({task_id:'task',actor_user_id:2,kind:'save',request_id:op.input.request_id,found:true,response:{...task,revision:2,requirements:{revision:1,document:op.input.requirements,override:null}}})
 await m.resolve();expect(api.save).toHaveBeenCalledTimes(1);expect(storage.pending).toBeNull();expect(m.ready.value).toBe(false);expect(changed).toHaveBeenCalledTimes(1)
})
test('conflict retains edited draft while explicit reload refreshes expected revision',async()=>{
 const {m}=await render();m.draft.value.goal='My draft';api.save.mockRejectedValueOnce(new TeamApiError(409,{error:{code:'revision_conflict'}}));m.prepare('save');await m.save();expect(storage.pending).toBeNull();expect(m.ready.value).toBe(false)
 api.get.mockResolvedValueOnce({...task,revision:4});await m.load();expect(m.draft.value.goal).toBe('My draft');m.prepare('save');expect(m.confirmation.value?.input.expected_revision).toBe(4)
})
test('override requires a saved incomplete document and creator authority',async()=>{
 const {m}=await render();m.reason.value='Reason';m.prepare('override');expect(m.confirmation.value).toBeNull()
 api.get.mockResolvedValueOnce({...task,creator_user_id:3,requirements:{document:{goal:'Goal',scope:'',repository:null,acceptance:''},revision:1,readiness:{status:'needs_information',missing:['scope']},override:null}})
 await m.load();m.reason.value='Reason';m.prepare('override');expect(m.confirmation.value?.kind).toBe('override')
})
test('rendered requirements panel edits and explicitly confirms through the persistent path',async()=>{
 const {default:Panel}=await import('../../components/team/TeamTaskRequirementsPanel.vue')
 const w=mount(Panel,{props:{teamId:'team',taskId:'task',currentUserId:2,teamCreatorId:2,writesEnabled:true}});wrappers.push(w);await flushPromises()
 expect(w.text()).toContain('team.requirements.unsaved')
 await w.get('[data-testid="requirements-scope"]').setValue('API module')
 await w.get('form').trigger('submit');expect(api.save).not.toHaveBeenCalled()
 await w.get('[data-testid="requirements-confirm"]').trigger('click');await flushPromises()
 expect(api.save.mock.calls[0][1].requirements.scope).toBe('API module');expect(storage.pending).toBeNull();expect(w.emitted('changed')).toHaveLength(1)
})

test('successful reload clears the old reload instruction',async()=>{
 const {m}=await render();m.prepare('save');await m.save();expect(m.notice.value).toBe('team.requirements.saved')
 await m.load();expect(m.notice.value).toBe('');expect(m.ready.value).toBe(true)
})
