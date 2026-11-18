import { createApp, defineComponent, h } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import '../src/assets/web-shared.css'
import '../src/assets/reference-workspace.css'
import '../src/assets/action-select.css'

// Only this dev harness replaces transport; no real account or Relay is accessed.
const id = 'local-unified-reply-demo'
const session = {session_id:id,daemon_id:'local-host',hostname:'本地预览',agent:'codex',agent_type:'codex',control_mode:'managed',daemon_online:true,status:'idle',title:'优化会话列表加载体验',cwd:'/demo/pocketctl',source:'daemon',model:'gpt-5.4',capabilities:['user_message','message_acceptance_receipt']}
let socket: LocalSocket
const performanceRows = Math.min(1000, Number(new URLSearchParams(location.search).get('performance')) || 0)
const olderFixture = new URLSearchParams(location.search).has('older')
let sequence = performanceRows * 2 + 100
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
    if(message.type==='replay' && message.direction==='forward'){
      const newest = performanceRows * 2 + 101
      if(message.last_seq < newest)this.emit({type:'replay_batch',session_id:id,req_id:message.req_id,direction:'forward',events:[{type:'agent_text',session_id:id,event_id:'refresh-latest',text:'手动刷新补回的消息',seq:newest}]})
      this.emit({type:'replay_end',session_id:id,req_id:message.req_id,last_seq:newest,newest_seq:newest,has_more:false})
      return
    }
    if(message.type==='replay' && message.last_seq){
      queued.push(()=>{
        this.emit({type:'replay_batch',session_id:id,req_id:message.req_id,direction:'backward',events:[{type:'user_text',session_id:id,text:'Earlier history is loaded without jumping.',event_id:'older-question',seq:1}]})
        this.emit({type:'replay_end',session_id:id,req_id:message.req_id,last_seq:1,has_more:false,status:'idle'})
      });return
    }
    if(message.type==='replay'){
      this.emit({type:'replay_batch',session_id:id,req_id:message.req_id,direction:'backward',events:performanceRows ? Array.from({length: Math.floor(performanceRows / 2)}, (_, i) => [
        {type:'user_text',session_id:id,text:`Historical prompt ${i}`,event_id:`perf-u-${i}`,turn_id:`perf-${i}`,seq:i*3+1},
        {type:'agent_text',session_id:id,text:`Historical reply ${i}\n\n` + 'A completed paragraph keeps the reading position stable while new output arrives. '.repeat(24),event_id:`perf-a-${i}`,turn_id:`perf-${i}`,seq:i*3+2,streaming:false},
      ]).flat() : [
        {type:'user_text',session_id:id,text:'先检查当前列表。',msg_id:'old',seq:1},reply(0),
        {type:'user_text',session_id:id,text:question,msg_id:'latest',seq:3},reply(1), {type:'tool_call',session_id:id,call_id:'display-tool',tool:'Read',input:{file_path:'/demo/src/session.ts'},seq:10}, {type:'tool_result',session_id:id,call_id:'display-tool',output:'export const cached = true;\n// synthetic output',seq:11}]})
      this.emit({type:'replay_end',session_id:id,req_id:message.req_id,last_seq:sequence,newest_seq:sequence,has_more:olderFixture,status:'idle'})
    }
    if(message.type==='get_session_meta')this.emit({type:'session_meta',session_id:id,agent:'codex',model:'gpt-5.4',control_mode:'managed',status:'idle',capabilities:performanceRows ? session.capabilities : ['user_message']})
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
// Foreground-only observations on the real SessionDetail component. The header
// writes its own metrics once per second and never drives the component render.
let streamTimer: ReturnType<typeof setInterval> | undefined
let chunkCount = 0, byteOffset = 0, run = 0, running = false, chunkSequence = 0
let lastFrame = 0, gaps: number[] = [], inputs: number[] = [], textSource = ''
function startStream() {
  if (running) return
  if (!streamTimer) {
    run++; chunkCount = 0; byteOffset = 0; chunkSequence = 0; textSource = ''; gaps = []; inputs = []; lastFrame = 0
    socket.emit({type:'user_text',session_id:id,text:`Continuous output run ${run}; type in the composer or read older history.`,turn_id:`live-${run}`,msg_id:`live-u-${run}`,seq:++sequence})
  }
  running = true
  socket.emit({type:'session_status',session_id:id,status:'running'})
  streamTimer = setInterval(() => {
    if (!running) return
    const text = `Chunk ${++chunkCount}: continuous output keeps arriving while you scroll and type. ` + (chunkCount % 5 === 0 ? '\n\n' : '')
    socket.emit({type:'agent_text',session_id:id,stream_id:`perf-stream-${run}`,turn_id:`live-${run}`,chunk_seq:chunkSequence++,byte_offset:byteOffset,text,streaming:true,seq:++sequence})
    byteOffset += new TextEncoder().encode(text).length; textSource += text
  }, 50)
}
function pauseStream() { running = false; if (streamTimer) clearInterval(streamTimer) }
function finishStream() {
  pauseStream(); streamTimer = undefined
  socket.emit({type:'agent_text',session_id:id,stream_id:`perf-stream-${run}`,turn_id:`live-${run}`,chunk_seq:chunkSequence++,byte_offset:byteOffset,text:'',final:true,total_bytes:byteOffset,seq:++sequence})
  socket.emit({type:'turn_status',session_id:id,turn_id:`live-${run}`,turn_status:'completed',seq:++sequence})
  socket.emit({type:'session_status',session_id:id,status:'idle'})
}
function sampleFrame(now: number) {
  if (running && !document.hidden) { if (lastFrame) gaps.push(now-lastFrame); lastFrame = now } else lastFrame = 0
  requestAnimationFrame(sampleFrame)
}
requestAnimationFrame(sampleFrame)
document.addEventListener('input', (event) => {
  if (!(event.target instanceof HTMLTextAreaElement) || document.hidden) return
  const start = performance.now(); requestAnimationFrame(() => { if (!document.hidden) inputs.push(performance.now()-start) })
})
const percentile = (values: number[], p: number) => values.length ? [...values].sort((a,b)=>a-b)[Math.min(values.length-1, Math.floor(values.length*p))].toFixed(1) : '—'
setInterval(() => {
  const output = document.querySelector('#stream-metrics')
  if (output) output.textContent = `History ${performanceRows} · ${running ? 'RUNNING 20Hz' : 'PAUSED / FINISHED'} · chunks ${chunkCount} · rAF p95/max ${percentile(gaps,.95)}/${percentile(gaps,1)}ms · input→rAF p95 ${percentile(inputs,.95)}ms (${inputs.length})`
}, 1000)
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
  h('header',{style:'flex:none;display:flex;flex-wrap:wrap;gap:8px;padding:8px 16px;border-bottom:1px solid var(--border)'},[
    h('strong','会话显示 · 实际 Web 组件 · 合成传输'),
    ...(performanceRows ? [
      h('select',{value:String(performanceRows),'aria-label':'历史条数',onChange:(event: Event)=>{location.search='?performance='+(event.target as HTMLSelectElement).value}},[h('option',{value:'200'},'200条历史'),h('option',{value:'1000'},'1000条历史')]),
      h('button',{onClick:startStream},'开始 / 继续 20Hz'),h('button',{onClick:pauseStream},'暂停输出'),h('button',{onClick:finishStream},'完成终态'),
      h('output',{id:'stream-metrics',style:'flex-basis:100%;font:12px monospace'},'Ready'),
    ] : []),
    h('button',{onClick:()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light'}},'深浅色'),
    h('button',{onClick:()=>socket.emit(reply(++sequence))},'追加回复'),
    h('button',{onClick:()=>{sessionStorage.setItem('session-display-pause','yes');location.reload()}},'延迟接口重新打开'),
    h('button',{onClick:()=>{paused=false;sessionStorage.removeItem('session-display-pause');queued.splice(0).forEach(run=>run())}},'返回接口数据'),
    h('button',{onClick:()=>auth.logout()},'退出测试账号'),
    h('button',{onClick:()=>{const e=document.querySelector<HTMLElement>('.chat-messages')!;e.scrollTo({top:0,behavior:'instant'})}},'查看更早历史'),
  ]),h(SessionDetail)
])})).use(router).mount('#app')
