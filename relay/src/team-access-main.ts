import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { setTeamAccess } from './team/access.js'

export function parseTeamAccessArgs(args: string[]): { action: 'enable' | 'disable' | 'status'; userId: number; operator: string; reason: string } {
  const [action, ...rest] = args
  if (!['enable', 'disable', 'status'].includes(action ?? '')) throw new Error('Usage: team:access enable|disable|status --user-id ID [--operator NAME --reason TEXT]')
  const values = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!, value = rest[i + 1]
    if (!['--user-id', '--operator', '--reason'].includes(key) || values.has(key) || !value || value.startsWith('--')) throw new Error('Unknown, repeated or incomplete option')
    values.set(key, value)
  }
  const id = values.get('--user-id') ?? ''
  const userId = Number(id)
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(userId) || userId > 2_147_483_647) throw new Error('--user-id must be a positive PostgreSQL account ID')
  const operator = values.get('--operator')?.trim() ?? '', reason = values.get('--reason')?.trim() ?? ''
  if (action !== 'status' && (!operator || !reason || operator.length > 100 || reason.length > 1000)) throw new Error('enable/disable require --operator and --reason')
  return { action: action as 'enable' | 'disable' | 'status', userId, operator, reason }
}

async function main(): Promise<void> {
  // Parse before opening the DB; never run schema migration from this command.
  const input = parseTeamAccessArgs(process.argv.slice(2))
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 30_000 })
  try {
    if (input.action === 'status') {
      const user = (await pool.query('SELECT id AS user_id, team_enabled FROM users WHERE id = $1', [input.userId])).rows[0]
      if (!user) throw new Error('Account not found')
      console.log(JSON.stringify(user))
    } else {
      console.log(JSON.stringify(await setTeamAccess(pool, { ...input, enabled: input.action === 'enable' })))
    }
  } finally { await pool.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(error => {
    // Do not print connection details or credentials in operator output.
    console.error(error instanceof Error && (error.message.startsWith('Usage:') || error.message.startsWith('--user-id')
      || error.message.startsWith('enable/disable') || error.message === 'Account not found'
      || error.message === 'DATABASE_URL is required' || error.message === 'Unknown, repeated or incomplete option')
      ? error.message : 'Team access command failed; check database availability and migration status')
    process.exitCode = 1
  })
}
