import {test,expect} from 'vitest'
import Fastify from 'fastify'
import {randomUUID} from 'node:crypto'
import {registerMaintenanceRoutes} from '../extensions/maintenance-routes.js'
import {signProviderExtensionToken} from '../extensions/provider-auth.js'
test('accepts completed Memory maintenance after legacy transport retirement, but rejects unknown counters',async()=>{
 const app=Fastify(),secret='maintenance-test-secret',issuer='http://relay.test'
 // Persistence is outside this HTTP validation test; authentication and route are real.
 const writes:any[]=[]
 const pool={query:async(_sql:string,args:any[])=>{writes.push(args);return {rows:[{}],rowCount:1}}}
 registerMaintenanceRoutes(app,{pool:pool as any,mode:'enabled',providerJwtSecret:secret,issuer})
 const slot=new Date(Date.now()-86400000);slot.setUTCHours(19,0,0,0)
 const body={installation_id:randomUUID(),scheduled_at:slot.toISOString(),revision:12,state:'completed',counts:{inbox_skipped_retired:1,inbox_body:0,source_events:605},started_at:slot.toISOString(),completed_at:slot.toISOString()}
 const headers={authorization:'Bearer '+signProviderExtensionToken({providerId:'pocketctl-memory',credentialId:randomUUID(),secret,issuer})}
 try{
  const response=await app.inject({method:'POST',url:'/api/extensions/v1/maintenance',headers,payload:body})
  expect(response.statusCode).toBe(200);expect(response.json()).toEqual({accepted:true})
  expect(JSON.parse(writes[0][5])).toEqual(body.counts)
  expect((await app.inject({method:'POST',url:'/api/extensions/v1/maintenance',headers,payload:{...body,counts:{private_field:1}}})).statusCode).toBe(400)
 }finally{await app.close()}
})
