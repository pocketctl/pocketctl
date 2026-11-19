import {expect,test,vi} from 'vitest'
import {mount} from '@vue/test-utils'
import StatisticsChart from './StatisticsChart.vue'
vi.mock('../../composables/useLocale',()=>({useLocale:()=>({t:(key:string)=>key})}))
const metric=(value:number|null,status:'complete'|'partial'|'unavailable'='complete')=>({value,status,coverageStart:null})
test('draws observed zeros as partial points and leaves missing days blank',()=>{
 const daily=[{date:'2026-11-01',newUsers:metric(0),activeUsers:metric(0,'partial'),sessions:metric(0),memory:metric(null,'unavailable')},{date:'2026-11-02',newUsers:metric(0),activeUsers:metric(4),sessions:metric(0),memory:metric(null,'unavailable')}]
 daily.push({...daily[1],date:'2026-11-03',activeUsers:metric(null,'unavailable')})
 const wrapper=mount(StatisticsChart,{props:{daily,previous:[],metric:'activeUsers',compare:false}})
 expect(wrapper.findAll('.point')).toHaveLength(2)
 expect(wrapper.get('.point.partial title').text()).toContain('stats.observedPartial')
 expect(wrapper.get('.current').attributes('d')).toBe('M42,220 L446,22')
})
