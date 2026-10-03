<template>
  <component :is="to ? RouterLink : 'section'" :to="to" class="card metric">
    <div class="metric-label">{{ label }}<WorkspaceIcon :name="icon" class="icon small" /></div>
    <div class="metric-value">{{ value }}<small v-if="unit">{{ unit }}</small></div>
    <div class="metric-foot"><slot>{{ foot }}</slot></div>
    <svg v-if="spark && sparkValues?.length" class="spark" viewBox="0 0 90 30" aria-hidden="true"><path :d="sparkPath" fill="none" stroke="currentColor" stroke-width="1.8" /></svg>
  </component>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import WorkspaceIcon from '../WorkspaceIcon.vue'
const props=defineProps<{label:string;value:string|number;foot?:string;icon:string;unit?:string;spark?:boolean;sparkValues?:number[];to?:string|object}>()
const sparkPath=computed(()=>{const values=props.sparkValues||[],max=Math.max(1,...values);return values.map((value,index)=>`${index?'L':'M'}${1+index/(Math.max(1,values.length-1))*88} ${29-value/max*28}`).join(' ')})
</script>
