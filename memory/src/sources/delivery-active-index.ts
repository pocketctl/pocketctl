import type pg from 'pg'
import type {MemoryNamespace} from '../migrations/shared-db/schema-context.js'

const activePredicate = "projection_state IN ('pending', 'quarantined')"
const tables = {
  memory_feed_inbox: 'memory_feed_inbox_active_state_installation',
  memory_source_delivery_receipts: 'memory_source_delivery_receipts_active_state_installation',
} as const

type IndexState = { name: string; matches: boolean; usable: boolean }

// Only identifiers chosen from the known layouts enter DDL. Resolve the view's
// actual dependency so a stale or partially transitioned layout fails closed.
async function deliveryTable(client: pg.PoolClient, namespace: MemoryNamespace): Promise<keyof typeof tables> {
  const {rows} = await client.query(`
    SELECT DISTINCT base.relname, ns.nspname, base.relkind
    FROM pg_rewrite r
    JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
      AND d.refclassid='pg_class'::regclass AND d.refobjid<>r.ev_class
    JOIN pg_class base ON base.oid=d.refobjid
    JOIN pg_namespace ns ON ns.oid=base.relnamespace
    WHERE r.ev_class=to_regclass($1) AND r.rulename='_RETURN'`,
    [namespace + '.memory_source_delivery_facts'])
  const table = rows[0]?.relname
  if (rows.length !== 1 || rows[0].nspname !== namespace || rows[0].relkind !== 'r' ||
      (table !== 'memory_feed_inbox' && table !== 'memory_source_delivery_receipts')) {
    throw Error('memory_delivery_facts_base_mismatch')
  }
  return table
}

async function indexStates(client: pg.PoolClient, relation: string, managed: string): Promise<IndexState[]> {
  return (await client.query<IndexState>(`
    SELECT obj.relname AS name,
      COALESCE(i.indrelid=to_regclass($1) AND NOT i.indisunique
        AND i.indnatts=2 AND i.indnkeyatts=2
        AND am.amname='btree' AND i.indexprs IS NULL AND
        (SELECT array_agg(a.attname::text ORDER BY k.pos)
         FROM generate_series(0,1) AS k(pos)
         JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[k.pos]
         JOIN pg_opclass oc ON oc.oid=i.indclass[k.pos] AND oc.opcdefault
         WHERE i.indoption[k.pos]=0 AND i.indcollation[k.pos]=a.attcollation)
         = ARRAY['projection_state','installation_id']
        AND pg_get_expr(i.indpred,i.indrelid)=ANY($3::text[]), false) AS matches,
      COALESCE(i.indisvalid AND i.indisready AND i.indislive, false) AS usable
    FROM pg_class obj LEFT JOIN pg_index i ON i.indexrelid=obj.oid
    LEFT JOIN pg_am am ON am.oid=obj.relam
    WHERE i.indrelid=to_regclass($1) OR obj.oid=to_regclass($2)`,
    [relation, managed, [
      "(projection_state = ANY (ARRAY['pending'::text, 'quarantined'::text]))",
      "(projection_state = ANY (ARRAY['quarantined'::text, 'pending'::text]))",
    ]])).rows
}

/** Requires an autocommit connection. The same advisory key fences storage
 * retirement while PostgreSQL's concurrent index build spans transactions. */
export async function ensureDeliveryActiveIndex(client: pg.PoolClient, namespace: MemoryNamespace): Promise<void> {
  if (namespace !== 'public' && namespace !== 'memory') throw Error('invalid_memory_namespace')
  await client.query("SELECT pg_advisory_lock(hashtextextended('memory:retention:migrations',0))")
  try {
    const table = await deliveryTable(client, namespace)
    const relation = namespace + '.' + table
    const name = tables[table]
    const managed = namespace + '.' + name
    const states = await indexStates(client, relation, managed)
    const existing = states.find(row => row.name === name)
    if (existing && !existing.matches) throw Error('memory_delivery_active_index_name_conflict')
    if (existing && !existing.usable) await client.query(`DROP INDEX CONCURRENTLY ${managed}`)
    if (states.some(row => row.matches && row.usable)) return
    await client.query(`CREATE INDEX CONCURRENTLY ${name} ON ${relation} (projection_state, installation_id)
      WHERE ${activePredicate}`)
    const verified = await indexStates(client, relation, managed)
    if (!verified.some(row => row.name === name && row.matches && row.usable)) {
      throw Error('memory_delivery_active_index_invalid')
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended('memory:retention:migrations',0))")
  }
}
