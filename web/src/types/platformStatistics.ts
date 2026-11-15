export interface StatisticsMetric {value:number|null;status:'complete'|'partial'|'unavailable';coverageStart:string|null;reason?:string}
export type StatisticsMetricKey='newUsers'|'activeUsers'|'sessions'|'memory'|'memoryUsers'|'readRequests'
export type StatisticsCoreMetricKey='newUsers'|'activeUsers'|'sessions'|'memory'
export interface StatisticsRange {from:string;to:string}
export type StatisticsDaily={date:string}&Record<StatisticsCoreMetricKey,StatisticsMetric>
export interface PlatformStatistics {
 definitionVersion:string;timezone:string;dataThrough:string;range:StatisticsRange;previousRange:StatisticsRange;comparisonAvailable:boolean
 metrics:Record<StatisticsMetricKey,StatisticsMetric>;previous:Record<StatisticsMetricKey,StatisticsMetric>;daily:StatisticsDaily[];previousDaily:StatisticsDaily[]
 memorySources:Record<'automatic'|'manual'|'unclassified',StatisticsMetric>;actualUse:{value:null;status:'unconfirmed'};exclusions:string[];warnings:string[]
}
