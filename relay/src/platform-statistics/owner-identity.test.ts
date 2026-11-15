import {describe,it,expect,vi} from 'vitest'
import Fastify from 'fastify'
import type {Pool} from 'pg'
import {registerPlatformStatisticsRoutes} from './routes.js'
import {platformStatisticsConfig} from './config.js'
const email='james_2001_2001@163.com'
const paths=['/api/admin/statistics/access','/api/admin/statistics','/api/admin/statistics/export.csv']
function fixture(databaseEmail:string|null=email,env:NodeJS.ProcessEnv={}){
 const current={email:databaseEmail},query=vi.fn(async(sql:string,values:unknown[])=>{
  expect(sql).toMatch(/SELECT\s+email\s+FROM\s+users\s+WHERE\s+id\s*=\s*\$1/i)
  expect(values).toEqual([42])
  return {rows:current.email===null?[]:[{email:current.email}]}
 })
 const app=Fastify()
 registerPlatformStatisticsRoutes(app,{pool:{query} as unknown as Pool,env:{PLATFORM_STATS_ENABLED:'true',...env},
  // A signed token's old email is deliberately not the controlling source.
  verifyAccessToken:async token=>token==='valid'?{userId:42,email}:null})
 return {app,current,query}
}
async function checkDenied(app:ReturnType<typeof Fastify>){
 for(const path of paths){const response=await app.inject({url:path,headers:{authorization:'Bearer valid'}})
  expect(response.statusCode).toBe(path.endsWith('/access')?200:403)
  expect(response.headers['cache-control']).toContain('no-store')
  if(path.endsWith('/access'))expect(response.json()).toEqual({allowed:false})
  expect(response.body).not.toContain(email)
 }
}
describe('single designated statistics account',()=>{
 it('allows the designated current database email without a user-id pin',async()=>{
  const {app,query}=fixture();try{const response=await app.inject({url:paths[0],headers:{authorization:'Bearer valid'}});expect(response.json()).toEqual({allowed:true});expect(query).toHaveBeenCalledTimes(1)}finally{await app.close()}
 })
 it('normalizes existing account email case and whitespace only',async()=>{
  const {app}=fixture(' JAMES_2001_2001@163.COM ');try{expect((await app.inject({url:paths[0],headers:{authorization:'Bearer valid'}})).json()).toEqual({allowed:true})}finally{await app.close()}
 })
 it.each(['other@163.com','james_2001_2001+admin@163.com','james_2001_2001@163.com.attacker.test',null])('rejects other/deleted account %s despite token email and matching configured id',async value=>{
  const {app}=fixture(value,{PLATFORM_STATS_OWNER_USER_ID:'42'});try{await checkDenied(app)}finally{await app.close()}
 })
 it('retains an optional stable account-id restriction and fails closed on malformed pins',async()=>{
  for(const pin of ['43','invalid',' 42 ','0']){const {app}=fixture(email,{PLATFORM_STATS_OWNER_USER_ID:pin});try{await checkDenied(app)}finally{await app.close()}}
 })
 it('keeps a bad optional access pin separate from collector validity',()=>{
  const config=platformStatisticsConfig({PLATFORM_STATS_ENABLED:'true',PLATFORM_STATS_OWNER_USER_ID:'invalid'})
  expect(config.valid).toBe(true)
  expect(config.ownerUserId).toBeNull()
 })
 it('denies the old token immediately after current email binding changes',async()=>{
  const {app,current}=fixture();try{expect((await app.inject({url:paths[0],headers:{authorization:'Bearer valid'}})).json()).toEqual({allowed:true});current.email='different@163.com';await checkDenied(app)}finally{await app.close()}
 })
 it('fails closed on database lookup failure',async()=>{
  const {app,query}=fixture();query.mockRejectedValue(new Error('database unavailable'));try{await checkDenied(app)}finally{await app.close()}
 })
 it('does not permit an environment email override or disclose the allowed email',async()=>{
  const {app}=fixture('other@163.com',{PLATFORM_STATS_OWNER_EMAIL:'other@163.com',PLATFORM_STATS_OWNER_USER_ID:'42'});try{await checkDenied(app)}finally{await app.close()}
 })
 it('still requires authentication and explicit feature enablement',async()=>{
  const {app,query}=fixture(email,{PLATFORM_STATS_ENABLED:'false'});try{await checkDenied(app);expect(query).not.toHaveBeenCalled();for(const url of paths)expect((await app.inject({url})).statusCode).toBe(401)}finally{await app.close()}
 })
})
