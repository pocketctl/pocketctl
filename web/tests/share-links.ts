// Local-only component fixture. No real account, credentials, or network API calls.
import {createApp,defineComponent,h,ref} from 'vue'
import ShareLinkManager from '../src/components/sharing/ShareLinkManager.vue'
import ShareLinkDialog from '../src/components/sharing/ShareLinkDialog.vue'
import {shareLinksAPI} from '../src/services/shareLinks'
import '../src/assets/reference-workspace.css'
let records=Array.from({length:3},(_,i)=>({id:`1111111${i}-1111-4111-8111-111111111111`,session_id:'fixture-session',title:'分享链接管理 · 本地组件验证',status:'active' as const,created_at:new Date(Date.now()-i*60000).toISOString(),expires_at:new Date(Date.now()+900000-i*60000).toISOString(),server_time:new Date().toISOString()}))
shareLinksAPI.list=async()=>({links:records,server_time:new Date().toISOString()})
shareLinksAPI.create=async()=>{const record={...records[0],id:crypto.randomUUID(),created_at:new Date().toISOString(),expires_at:new Date(Date.now()+900000).toISOString(),server_time:new Date().toISOString()};records.unshift(record);return record}
shareLinksAPI.revoke=async(id)=>{const record=records.find(r=>r.id===id)!;records=records.filter(r=>r.id!==id);return {...record,status:'revoked'}}
shareLinksAPI.get=async(id)=>records.find(r=>r.id===id)!
shareLinksAPI.url=async(id)=>({...records.find(r=>r.id===id)!,url:'https://example.invalid/share/fixture-only'})
createApp(defineComponent({setup(){const modal=ref(false),dark=ref(false);return()=>h('div',{class:'design-shell'},[h('main',{class:'design-surface',style:'max-width:1120px'},[h('p',{style:'color:var(--muted);font-size:12px'},'LOCAL FIXTURE · 使用真实产品组件，示例数据，无外部分享'),h('div',{class:'row',style:'margin:20px 0'},[h('button',{class:'btn',onClick:()=>modal.value=true},'打开分享会话'),h('button',{class:'btn',onClick:()=>{dark.value=!dark.value;document.documentElement.dataset.theme=dark.value?'dark':'light'}},'切换深浅色')]),h(ShareLinkManager),modal.value?h(ShareLinkDialog,{sessionId:'fixture-session',title:'分享链接管理 · 本地组件验证',onClose:()=>modal.value=false,onManage:()=>modal.value=false}):null])])}})).mount('#app')
