import Fastify from 'fastify'
import {expect,test} from 'vitest'
import {registerStatusRoutes} from '../../relay/src/extensions/status-routes.js'
import {signProviderExtensionToken} from '../../relay/src/extensions/provider-auth.js'
import {createStatusWorker} from '../src/reporting/status-worker.js'

test('fractional, negative and oversized database counters satisfy the real Relay status route',async()=>{
 const app=Fastify()
 const secret='local-status-contract-only'
 const issuer='status-contract-test'
 const token=signProviderExtensionToken({providerId:'pocketctl-memory',credentialId:'test',secret,issuer})
 const writes:unknown[][]=[]
 registerStatusRoutes(app,{mode:'enabled',providerJwtSecret:secret,issuer,
  pool:{query:async(_sql:string,values:unknown[])=>{writes.push(values);return{rowCount:1,rows:[]}}} as never,
  verifyAccessToken:async()=>null})
 try{
  for(const lag of ['301.123456','-1.123456','9007199254740993000','NaN']){
   const row={installation_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',local_status:'ready',relay_status:'active',feed_enabled:true,
    feed_lag_seconds:lag,last_feed_id:'9007199254740993000',pending_jobs:'-4',failed_jobs_24h:'2.75',
    extraction_mode:'off',budget_deferred:0,evidence_gaps:0,last_extract_seconds:null,oldest_extract_seconds:null,last_error_code:null}
   const worker=createStatusWorker({providerVersion:'test',pool:{query:async()=>({rows:[row]})} as never,
    reportStatus:async payload=>{
     const response=await app.inject({method:'POST',url:'/api/extensions/v1/status',headers:{authorization:`Bearer ${token}`},payload})
     expect(response.statusCode,response.body).toBe(200)
    }})
   await worker.runOnce()
  }
  expect(writes.map(values=>values.slice(4,8))).toEqual([
   [Number.MAX_SAFE_INTEGER,301,0,2], [Number.MAX_SAFE_INTEGER,0,0,2],
   [Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,0,2], [Number.MAX_SAFE_INTEGER,0,0,2],
  ])
 }finally{await app.close()}
})
