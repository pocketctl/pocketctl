import type pg from 'pg'

/** Only call after installing both authoritative readers. Removing NOT NULL
 * does not weaken the mutually exclusive body location or ownership checks. */
export async function enableSessionColdBodies(db:Pick<pg.Pool,'query'>):Promise<void>{
  await db.query(`ALTER TABLE events ALTER COLUMN payload DROP NOT NULL;
    ALTER TABLE session_document_versions ALTER COLUMN content_bytes DROP NOT NULL`)
}
