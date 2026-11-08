import {afterEach,expect,test,vi} from 'vitest'
const calls=vi.hoisted(()=>({schema:vi.fn(),contract:vi.fn(),provision:vi.fn(),query:vi.fn(async()=>({rows:[{name:'target'}]})),end:vi.fn()}))
vi.mock('pg',()=>({default:{Pool:class{query=calls.query;end=calls.end}}}))
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
