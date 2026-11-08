import type pg from 'pg'

/** Only call after installing both authoritative readers. Removing NOT NULL
 * does not weaken the mutually exclusive body location or ownership checks. */
export async function enableSessionColdBodies(db:Pick<pg.Pool,'query'>):Promise<void>{
  await db.query(`ALTER TABLE events ALTER COLUMN payload DROP NOT NULL;
    ALTER TABLE session_document_versions ALTER COLUMN content_bytes DROP NOT NULL`)
}

/** Read-only runtime counterpart. Configuration never implicitly performs DDL. */
export async function assertSessionColdBodiesEnabled(db:Pick<pg.Pool,'query'>):Promise<void>{
 const columns=(await db.query(`SELECT c.relname,a.attname,a.attnotnull FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
  WHERE c.relnamespace='public'::regnamespace AND (c.relname,a.attname) IN (('events','payload'),('session_document_versions','content_bytes'))`)).rows
 if(columns.length!==2 || columns.some(c=>c.attnotnull))throw new Error('session_cold_schema_migrator_required')
}
