// Isolated verification fixture only; never imported by the maintenance CLI.
import pg from 'pg'
import {applyMemorySchema} from '../../schema.js'
const url=process.env.SHARED_SOURCE_TEST_DATABASE_URL
if(!url || new URL(url).pathname!=='/shared_source_schema_test')throw Error('isolated_schema_test_required')
const pool=new pg.Pool({connectionString:url})
try{await applyMemorySchema(pool);console.log('isolated_schema_prepared')}finally{await pool.end()}
