<script setup lang="ts">
import {computed} from 'vue'
import {useLocale} from '../../composables/useLocale'
import {chartPath} from './statisticsModel'
import type {StatisticsDaily,StatisticsCoreMetricKey} from '../../types/platformStatistics'
const props=defineProps<{daily:StatisticsDaily[];previous:StatisticsDaily[];metric:StatisticsCoreMetricKey;compare:boolean}>()
const {t}=useLocale()
const current=computed(()=>props.daily.map(d=>d[props.metric].status==='complete'?d[props.metric].value:null))
const prior=computed(()=>props.compare?props.previous.map(d=>d[props.metric].status==='complete'?d[props.metric].value:null):[])
const max=computed(()=>Math.ceil(Math.max(1,...current.value.filter((v):v is number=>v!==null),...prior.value.filter((v):v is number=>v!==null))/4)*4)
const x=(i:number)=>42+i*808/Math.max(1,current.value.length-1),y=(v:number)=>220-v/max.value*198
</script>
<template>
 <figure class="ps-chart"><svg viewBox="0 0 890 265" role="img" :aria-label="t('stats.chartAccessible')">
  <title>{{t('stats.'+metric)}} · {{t('stats.trend')}}</title><desc>{{t('stats.chartDescription')}}</desc>
  <g v-for="i in 5" :key="i"><line class="grid" x1="42" x2="850" :y1="y(max*(i-1)/4)" :y2="y(max*(i-1)/4)"/><text x="32" :y="y(max*(i-1)/4)+4" text-anchor="end">{{max*(i-1)/4}}</text></g>
  <path v-if="compare" class="prior" :d="chartPath(prior,max)"/><path class="current" :d="chartPath(current,max)"/>
  <template v-for="(v,i) in current" :key="daily[i]?.date"><circle v-if="v!==null" class="point" :cx="x(i)" :cy="y(v)" r="3"><title>{{daily[i]?.date}} · {{t('stats.'+metric)}}: {{v}} · {{t('stats.previous')}}: {{prior[i]??t('stats.unavailable')}}</title></circle><text v-if="i===0||i===current.length-1||i%Math.max(1,Math.ceil(current.length/7))===0" :x="x(i)" y="248" :text-anchor="i===0?'start':i===current.length-1?'end':'middle'">{{daily[i]?.date.slice(5).replace('-','/')}}</text></template>
 </svg></figure>
</template>
