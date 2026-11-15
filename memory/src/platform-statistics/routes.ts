import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { statisticsEnabled } from './schema.js'
import { loadStatisticsSnapshot, parseSnapshotQuery } from './service.js'

export function registerPlatformStatisticsRoutes(app:FastifyInstance,deps:{pool:pg.Pool;internalToken?:string}):void {
  if(!statisticsEnabled())return
  const token=deps.internalToken??process.env.PLATFORM_STATS_INTERNAL_TOKEN??''
  if(Array.from(token).length<32)throw new Error('PLATFORM_STATS_INTERNAL_TOKEN must contain at least 32 characters')
  const expected=Buffer.from(token)
  app.addHook('onRequest',async(request,reply)=>{if(request.url.split('?')[0]==='/internal/platform-statistics')reply.header('cache-control','no-store')})
  app.get('/internal/platform-statistics',async(request,reply)=>{
    reply.header('cache-control','no-store')
    const authorization=request.headers.authorization
    const supplied=Buffer.from(authorization?.startsWith('Bearer ')?authorization.slice(7):'')
    if(supplied.length!==expected.length||!timingSafeEqual(expected,supplied))return reply.code(401).send({error:'internal authorization required'})
    let query
    try{query=parseSnapshotQuery(request.query)}catch{return reply.code(400).send({error:'invalid statistics interval'})}
    try{return await loadStatisticsSnapshot(deps.pool,query)}catch{return reply.code(503).send({error:'statistics source unavailable'})}
  })
}
