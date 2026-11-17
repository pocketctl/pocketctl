import { createApp, defineComponent, h } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import '../src/assets/web-shared.css'
import '../src/assets/reference-workspace.css'
import '../src/assets/action-select.css'

// Only this dev harness replaces transport; no real account or Relay is accessed.
const id = 'local-unified-reply-demo'
const session = {session_id:id,daemon_id:'local-host',hostname:'本地预览',agent:'codex',agent_type:'codex',control_mode:'managed',daemon_online:true,status:'idle',title:'优化会话列表加载体验',cwd:'/demo/pocketctl',source:'daemon',model:'gpt-5.4',capabilities:['user_message','message_acceptance_receipt']}
let socket: LocalSocket
const olderFixture = new URLSearchParams(location.search).has('older')
let sequence = 100
let paused = sessionStorage.getItem('session-display-pause') === 'yes'
const queued: (() => void)[] = []
const later = (run: () => void) => { if (paused) queued.push(run); else setTimeout(run, 20) }
const question = '优化一下会话列表的加载体验，切换项目时不要整页闪烁。请保留当前筛选条件和滚动位置，并补充加载失败后的重试交互。'
const reply = (n: number) => ({type:'agent_text',session_id:id,text:`第 ${n} 段：保留阅读位置\n\n切换项目时保留已有列表，只更新当前项目的内容。后台刷新和新增消息都应尊重用户正在阅读的位置。\n\n- 保留筛选条件\n- 保留已有内容\n- 在原位置显示重试入口\n\n这里是实际 SessionDetail 组件中的合成回复。`,event_id:`reply-${n}`,seq:n+3,streaming:false})
class LocalSocket {
  static OPEN=1
  readyState=1
  onopen: ((event: any)=>void)|null=null
  onmessage: ((event:any)=>void)|null=null
  onclose: any=null
  onerror: any=null
  constructor(){socket=this;setTimeout(()=>this.onopen?.({}),0)}
  close(){this.readyState=3}
  emit(message:object){this.onmessage?.({data:JSON.stringify(message)})}
  send(raw:string){const message=JSON.parse(raw);later(()=>{
    if(message.type==='list_sessions')this.emit({type:'session_list',sessions:[session]})
    if(message.type==='list_daemons')this.emit({type:'daemon_list',daemons:[{daemon_id:'local-host',hostname:'本地预览',status:'online'}]})
    if(message.type==='replay' && message.last_seq){
      queued.push(()=>{
        this.emit({type:'replay_batch',session_id:id,req_id:message.req_id,direction:'backward',events:[{type:'user_text',session_id:id,text:'Earlier history is loaded without jumping.',event_id:'older-question',seq:1}]})
        this.emit({type:'replay_end',session_id:id,req_id:message.req_id,last_seq:1,has_more:false,status:'idle'})
      });return
    }
    if(message.type==='replay'){
      this.emit({type:'replay_batch',session_id:id,req_id:message.req_id,direction:'backward',events:[
        {type:'user_text',session_id:id,text:'先检查当前列表。',msg_id:'old',seq:1},reply(0),
        {type:'user_text',session_id:id,text:question,msg_id:'latest',seq:3},reply(1), {type:'tool_call',session_id:id,call_id:'display-tool',tool:'Read',input:{file_path:'/demo/src/session.ts'},seq:10}, {type:'tool_result',session_id:id,call_id:'display-tool',output:'export const cached = true;\n// synthetic output',seq:11}]})
      this.emit({type:'replay_end',session_id:id,req_id:message.req_id,last_seq:100,has_more:olderFixture,status:'idle'})
    }
    if(message.type==='get_session_meta')this.emit({type:'session_meta',session_id:id,agent:'codex',model:'gpt-5.4',control_mode:'managed',status:'idle',capabilities:['user_message']})
    if(message.type==='user_message'){
      this.emit({type:'user_message_ack',session_id:id,msg_id:message.msg_id})
      this.emit({type:'user_message_receipt',session_id:id,msg_id:message.msg_id,status:'accepted'})
      this.emit({type:'user_text',session_id:id,text:message.text,msg_id:message.msg_id,seq:++sequence})
    }
  })}
}
window.WebSocket=LocalSocket as any
window.fetch=async(input:any)=>{
  const path=new URL(String(input),location.origin).pathname
  if(path.endsWith('/auth/ws-ticket'))return Response.json({ticket:'fixture-only'})
  if(paused && ['/api/session-projects','/api/organized-sessions'].includes(path)) await new Promise<void>(resolve=>queued.push(resolve))
  if(path.endsWith('/auth/refresh'))return Response.json({error:'fixture'},{status:401})
  if(path==='/api/session-projects')return Response.json({projects:[],ungrouped_count:1,archived_count:0,project_order_revision:0,ungrouped_revision:0,ungrouped_order_mode:'activity'})
  if(path==='/api/organized-sessions')return Response.json({sessions:[session],has_more:false,next_cursor:null,revision:0,order_mode:'activity'})
  if(path.endsWith('/summary'))return Response.json({session})
  if(path.endsWith('/documents'))return Response.json({documents:[],has_more:false})
  return Response.json({seen:true})
}
const { useAuth } = await import('../src/composables/useAuth')
const auth = useAuth()
auth.user.value = {id:999999,email:null,phone:null,display_name:'Local fixture'}
auth.accessToken.value = 'fixture.' + btoa(JSON.stringify({exp:Math.floor(Date.now()/1000)+86400})) + '.fixture'
const { personalReadCache } = await import('../src/services/personalReadCache')
personalReadCache.activate({origin:location.origin,user:999999}, async () => ({key:btoa('c'.repeat(32)),key_id:'fixture',user_id:999999,expires_at:Date.now()+900000}))
const { useLocale } = await import('../src/composables/useLocale')
if (olderFixture) useLocale().locale.value = 'en'
const { default: SessionDetail } = await import('../src/views/SessionDetail.vue')
const router=createRouter({history:createMemoryHistory(),routes:[{path:'/session/:id',component:SessionDetail},{path:'/session/:id/document',name:'session-document-link',component:{render:()=>null}}]})
await router.push('/session/'+id)
document.documentElement.dataset.theme='light'
createApp(defineComponent({setup:()=>()=>h('div',{style:'height:100vh;display:flex;flex-direction:column'},[
  h('header',{style:'flex:none;display:flex;gap:12px;padding:12px 20px;border-bottom:1px solid var(--border)'},[
    h('strong','会话显示 · 实际 Web 组件 · 合成传输'),
    h('button',{onClick:()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light'}},'深浅色'),
    h('button',{onClick:()=>socket.emit(reply(++sequence))},'追加回复'),
    h('button',{onClick:()=>{sessionStorage.setItem('session-display-pause','yes');location.reload()}},'延迟接口重新打开'),
    h('button',{onClick:()=>{paused=false;sessionStorage.removeItem('session-display-pause');queued.splice(0).forEach(run=>run())}},'返回接口数据'),
    h('button',{onClick:()=>auth.logout()},'退出测试账号'),
    h('button',{onClick:()=>{const e=document.querySelector<HTMLElement>('.chat-messages')!;e.scrollTo({top:0,behavior:'instant'})}},'查看更早历史'),
  ]),h(SessionDetail)
])})).use(router).mount('#app')
