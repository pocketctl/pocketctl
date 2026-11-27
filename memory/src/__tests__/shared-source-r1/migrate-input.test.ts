import {afterEach,expect,test,vi} from 'vitest'
const calls=vi.hoisted(()=>({index:vi.fn(),release:vi.fn(),connect:vi.fn(),schema:vi.fn(),contract:vi.fn(),provision:vi.fn(),query:vi.fn(async()=>({rows:[{name:'target'}]})),end:vi.fn()}))
vi.mock('pg',()=>({default:{Pool:class{query=calls.query;connect=calls.connect;end=calls.end}}}))
vi.mock('../../sources/delivery-active-index.js',()=>({ensureDeliveryActiveIndex:calls.index}))
vi.mock('../../schema.js',()=>({applyMemorySchema:calls.schema}))
vi.mock('../../migrations/shared-db/contract.js',()=>({applySharedSourceContract:calls.contract}))
vi.mock('../../migrations/shared-db/namespace.js',()=>({provisionSharedDatabase:calls.provision}))
import {migrateMain} from '../../migrate-main.js'
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks()})
test.each([
 ['memory','personal-relay-only','not-a-uuid'],
 ['memory','personal-relay-only',undefined],
 ['memory','full','00000000-0000-0000-0000-000000000001'],
 ['public',undefined,'00000000-0000-0000-0000-000000000001'],
] as const)('invalid migration launch input is refused before any database operation (%s %s %s)',async(namespace,profile,ids)=>{
 vi.stubEnv('MEMORY_MIGRATION_DATABASE_URL','postgres://synthetic-only/target')
 vi.stubEnv('MEMORY_MIGRATION_SOURCE_TARGET_PROFILE',profile)
 vi.stubEnv('MEMORY_MIGRATION_PRESERVED_INSTALLATIONS',ids)
 expect(await migrateMain(['apply',namespace,'target'])).toBe(2)
 expect(calls.query).not.toHaveBeenCalled()
 expect(calls.schema).not.toHaveBeenCalled()
 expect(calls.contract).not.toHaveBeenCalled()
})

test('the index-only command verifies database identity before acquiring its DDL connection',async()=>{
 vi.stubEnv('MEMORY_MIGRATION_DATABASE_URL','postgres://synthetic-only/target')
 expect(await migrateMain(['ensure-delivery-index','memory','other'])).toBe(2)
 expect(calls.query).toHaveBeenCalledOnce()
 expect(calls.connect).not.toHaveBeenCalled()
 expect(calls.index).not.toHaveBeenCalled()
})

test('the index-only command is independent of full migration launch options',async()=>{
 vi.stubEnv('MEMORY_MIGRATION_DATABASE_URL','postgres://synthetic-only/target')
 vi.stubEnv('MEMORY_MIGRATION_SOURCE_TARGET_PROFILE','personal-relay-only')
 vi.stubEnv('MEMORY_MIGRATION_PRESERVED_INSTALLATIONS','not-a-uuid')
 const client={release:calls.release}
 calls.connect.mockResolvedValueOnce(client)
 expect(await migrateMain(['ensure-delivery-index','memory','target'])).toBe(0)
 expect(calls.index).toHaveBeenCalledWith(client,'memory')
 expect(calls.release).toHaveBeenCalledOnce()
 expect(calls.schema).not.toHaveBeenCalled()
 expect(calls.contract).not.toHaveBeenCalled()
})
