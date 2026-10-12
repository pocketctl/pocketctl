import pg from 'pg'

/** Refuse unsafe targets before schema initialization or any destructive fixture. */
export async function lifecycleTestPool(): Promise<pg.Pool> {
  const raw = process.env.TEST_DATABASE_URL
  if (!raw) throw new Error('TEST_DATABASE_URL required')
  const url = new URL(raw)
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/pocketctl_session_lifecycle_test' ||
    decodeURIComponent(url.username) !== 'pocketctl_session_lifecycle_test' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'dedicated loopback lifecycle test database and role required',
    )
  const pool = new pg.Pool({ connectionString: raw, max: 5 })
  try {
    const result = await pool.query(
      'SELECT current_database() AS db, current_user AS role',
    )
    if (
      result.rows[0].db !== 'pocketctl_session_lifecycle_test' ||
      result.rows[0].role !== 'pocketctl_session_lifecycle_test'
    )
      throw new Error('unsafe test database identity')
    return pool
  } catch (error) {
    await pool.end()
    throw error
  }
}
