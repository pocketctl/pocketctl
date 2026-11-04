import {createApp,defineComponent,h,ref} from 'vue'
import '../src/assets/web-shared.css'
import '../src/assets/reference-workspace.css'
import '../src/assets/action-select.css'
import '../src/components/memory/memory-workbench.css'
import MemoryLifecyclePanel from '../src/components/memory/MemoryLifecyclePanel.vue'
import ClaimDetailPanel from '../src/components/memory/ClaimDetailPanel.vue'
import CandidateReviewList from '../src/components/memory/CandidateReviewList.vue'
import MemorySearchPanel from '../src/components/memory/MemorySearchPanel.vue'
const fixture=await(await fetch('/__fixture')).json()
createApp(defineComponent({setup(){const tab=ref('processing'),generation=ref(0),mobile=ref(false);return()=>h('main',{class:'memory-workbench memory-layout-v2 design-surface',style:`max-width:${mobile.value?'390px':'1100px'};margin:0 auto;padding:24px;min-height:100vh`},[
 h('p',{style:'font-size:12px;color:var(--muted)'},'LOCAL TEST: actual components and API / isolated PostgreSQL. Synthetic authorization and source records; no model or production acceptance.'),
 h('nav',{style:'display:flex;flex-wrap:wrap;gap:8px;margin:16px 0'},[
 h('button',{class:'memory-button',onClick:()=>tab.value='processing'},'Processing'),h('button',{class:'memory-button',onClick:()=>tab.value='claims'},'Knowledge'),h('button',{class:'memory-button',onClick:()=>tab.value='search'},'Search'),h('button',{class:'memory-button',onClick:()=>mobile.value=!mobile.value},mobile.value?'Desktop width':'Phone width'),
 ...['off','shadow','enabled'].map(mode=>h('button',{class:'memory-button',onClick:async()=>{await fetch(`/__fixture/policy/${mode}`,{method:'POST'});generation.value++}},mode))]),
 h('div',{class:'memory-module-stage'},[tab.value==='processing'?h(MemoryLifecyclePanel,{key:generation.value,installationId:fixture.installationId},{default:()=>h(CandidateReviewList)}):tab.value==='search'?h(MemorySearchPanel,{installationId:fixture.installationId}):h(ClaimDetailPanel,{claimId:null})]),
])}})).mount('#app')
