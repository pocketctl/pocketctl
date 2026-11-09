import { afterEach, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prepareRetainedCatalog, assertRetainedCatalogCurrent, type RetainedCatalogIdentity, type RetainedCatalogCurrentIdentity } from '../../migrations/shared-forward/retained-authority-native-catalog.js'
import { RETAINED_NATIVE_SOURCE_PROFILE_SHA256 } from '../../migrations/shared-forward/retained-authority-native-profile.js'

// No create/drop/reset/tamper operation is permitted against these retained DBs.
// The only transaction control is BEGIN READ ONLY / BEGIN READ WRITE / ROLLBACK.
const enabled = process.env.G3_NATIVE_INTEGRATION === '1'
const sources = {
  '13': { id: '84d032e6f182c42023f2e14a442c1f9b4e3750c6ec5755edf63cb1952a3799f3', databaseOid: '232429', address: '172.17.0.8', version: '130023' as const },
  '17': { id: 'f4778110a4820dd23c1408a7aa877afcd74b070bd9837922450b24df2149ad75', databaseOid: '389996', address: '172.17.0.7', version: '170010' as const },
}
const currentIdentityBinding = (identity: RetainedCatalogIdentity): RetainedCatalogCurrentIdentity => ({ ...identity, configSha256: 'a'.repeat(64), sourceProfileSha256: RETAINED_NATIVE_SOURCE_PROFILE_SHA256, reviewSha256: 'b'.repeat(64), enclosingRegistrySha256: 'c'.repeat(64) })
const clients: Client[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map(c => c.end().catch(() => {}))) })
function guardedConnection(major: '13' | '17'): { client: Client; identity: RetainedCatalogIdentity } {
  const source = sources[major], name = 'pocketctl-task7-paged-pg' + major + '-20261108'
  const inspected = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8', timeout: 5000 }))[0]
  expect(inspected.Id).toBe(source.id)
  expect(inspected.Config.Image).toBe('postgres:' + major + '-alpine')
  expect(inspected.Config.Labels['pocketctl.verification']).toBe('task7-paged-cleanup-synthetic')
  expect(inspected.State.Running).toBe(true)
  const port = Number('565' + major)
  expect(inspected.NetworkSettings.Ports['5432/tcp']).toContainEqual({ HostIp: '127.0.0.1', HostPort: String(port) })
  expect(Object.values(inspected.NetworkSettings.Networks).map(n => (n as { IPAddress: string }).IPAddress)).toContain(source.address)
  const configPath = fileURLToPath(new URL('../../../../.superpowers/sdd/pocketctl-shared-w4-paged-cleanup/handoff-r4/synthetic-connection-config.json', import.meta.url))
  expect(statSync(configPath).mode & 0o777).toBe(0o600)
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { hosts: Record<string, string>; administrator: { user: string; password: string } }
  const host = new URL(config.hosts['pg' + major]!.includes('://') ? config.hosts['pg' + major]! : 'postgresql://' + config.hosts['pg' + major]!)
  expect(['localhost', '127.0.0.1']).toContain(host.hostname)
  expect(Number(host.port)).toBe(port)
  const database = 'task8_global_schema_proto' + major + '_test'
  const identity: RetainedCatalogIdentity = { database, databaseOid: source.databaseOid, role: config.administrator.user, roleOid: '10', serverAddress: source.address, serverPort: '5432', serverVersionNum: source.version }
  const client = new Client({ host: '127.0.0.1', port, database, user: config.administrator.user, password: config.administrator.password, connectionTimeoutMillis: 5000, application_name: 'pocketctl-retained-native-select-only', options: '-c search_path=pg_catalog -c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000 -c row_security=off -c TimeZone=UTC -c jit=off' })
  clients.push(client)
  return { client, identity }
}
async function verifyIdentityReadOnly(client: Client, identity: RetainedCatalogIdentity): Promise<void> {
  await client.query('BEGIN READ ONLY')
  try {
    const row = (await client.query(`SELECT current_database() AS database,d.oid::text AS database_oid,current_user AS role,session_user AS session_role,r.oid::text AS role_oid,r.rolsuper,host(inet_server_addr()) AS address,inet_server_port()::text AS port,current_setting('server_version_num') AS version FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0]
    expect(row).toEqual({ database: identity.database, database_oid: identity.databaseOid, role: identity.role, session_role: identity.role, role_oid: identity.roleOid, rolsuper: true, address: identity.serverAddress, port: identity.serverPort, version: identity.serverVersionNum })
  } finally { await client.query('ROLLBACK') }
}
describe.skipIf(!enabled)('retained prototype native SELECT-only catalog', () => {
  for (const major of ['13','17'] as const) it('verifies complete source-backed native closure on PG' + major, async () => {
    const { client, identity } = guardedConnection(major)
    const capture: { query: string; rows: unknown[] }[] = []
    const query = client.query.bind(client)
    client.query = (async (text: string) => { const result = await query(text); if (text.startsWith('WITH candidates')) capture.push({ query: text, rows: result.rows }); return result }) as typeof client.query
    await client.connect()
    const timer = setTimeout(() => { void client.end().catch(() => {}) }, 10000)
    try {
      await verifyIdentityReadOnly(client, identity)
      const prepared = prepareRetainedCatalog({ identity, configSha256: 'a'.repeat(64), sourceProfileSha256: RETAINED_NATIVE_SOURCE_PROFILE_SHA256, reviewSha256: 'b'.repeat(64), enclosingRegistry: { scope: 'isolated-three-object-prototype', sourceSha256: 'c'.repeat(64) }, tablespace: { name: 'pg_default', oid: '1663', ownerOid: '10' } })
      await client.query('BEGIN READ WRITE ISOLATION LEVEL READ COMMITTED')
      try { await assertRetainedCatalogCurrent(client, prepared, currentIdentityBinding(identity)) }
      finally { if (client.getTransactionStatus() === 'T' || client.getTransactionStatus() === 'E') await client.query('ROLLBACK') }
    } finally {
      clearTimeout(timer)
      if (process.env.G3_NATIVE_CAPTURE_DIR) writeFileSync(process.env.G3_NATIVE_CAPTURE_DIR + '/capture-pg' + major + '.json', JSON.stringify(capture), { flag: 'wx', mode: 0o600 })
    }
  })
})

// These exercise the module's actual SQL wire guard through the passed physical
// client. Candidate SELECTs are replaced in the test transport; no catalog object
// or native row is altered, and none is called a native DDL tamper test.
describe.skipIf(!enabled)('native server pretransfer row and exact JSON-byte guards', () => {
  for (const major of ['13','17'] as const) for (const kind of ['rowOverflow','byteOverflow','rowBoundary','byteBoundary'] as const) {
    it('PG' + major + ' ' + kind + ' has bounded server response before payload transfer', async () => {
      const { client, identity } = guardedConnection(major)
      await client.connect()
      const timer = setTimeout(() => { void client.end().catch(() => {}) }, 10000)
      try {
        await verifyIdentityReadOnly(client,identity)
        const prepared = prepareRetainedCatalog({ identity, configSha256: 'a'.repeat(64), sourceProfileSha256: RETAINED_NATIVE_SOURCE_PROFILE_SHA256, reviewSha256: 'b'.repeat(64), enclosingRegistry: { scope: 'isolated-three-object-prototype', sourceSha256: 'c'.repeat(64) }, tablespace: { name: 'pg_default', oid: '1663', ownerOid: '10' } })
        const query = client.query.bind(client)
        let output: { row_count: string; wire_bytes: string; wire: string | null } | undefined
        client.query = (async (sql: string) => {
          if (!sql.startsWith('WITH candidates')) return query(sql)
          const body = kind === 'rowOverflow' ? 'SELECT generate_series(1,1025) AS ordinal'
            : kind === 'rowBoundary' ? 'SELECT generate_series(1,1024) AS ordinal'
            : kind === 'byteOverflow' ? "SELECT repeat('x',8388608) AS payload"
            : `SELECT repeat('x',8388608-octet_length('{"rowCount":"1","rows":[{"payload": ""}]}')) AS payload`
          const left = sql.indexOf('FROM (') + 'FROM ('.length, right = sql.lastIndexOf(') AS candidate LIMIT 1025')
          expect(left).toBeGreaterThan(5);expect(right).toBeGreaterThan(left)
          const result = await query(sql.slice(0,left)+body+sql.slice(right))
          output = result.rows[0]
          return result
        }) as typeof client.query
        await client.query('BEGIN READ WRITE ISOLATION LEVEL READ COMMITTED')
        try {
          await expect(assertRetainedCatalogCurrent(client,prepared,currentIdentityBinding(identity))).rejects.toThrow(kind.endsWith('Overflow') ? 'wire_overflow' : 'current_identity')
          expect(output).toBeDefined()
          if (kind.endsWith('Overflow')) {
            expect(output!.wire).toBeNull()
            if (kind==='rowOverflow') expect(output!.row_count).toBe('1025')
            else expect(BigInt(output!.wire_bytes)).toBeGreaterThan(8388608n)
          } else if (kind==='rowBoundary') {
            expect(output!.row_count).toBe('1024')
            expect(JSON.parse(output!.wire!).rows).toHaveLength(1024)
          } else {
            expect(output!.wire_bytes).toBe('8388608')
            expect(Buffer.byteLength(output!.wire!)).toBe(8388608)
          }
        } finally { if (['T','E'].includes(client.getTransactionStatus()!)) await client.query('ROLLBACK') }
      } finally { clearTimeout(timer) }
    })
  }
})
