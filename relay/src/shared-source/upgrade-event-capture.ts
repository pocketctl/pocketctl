import type pg from 'pg'
import { RELAY_EVENT_CAPTURE_FUNCTION } from './capture-contract.js'
import { TURN_DIALOGUE_CAPTURE_FUNCTION } from './turn-dialogue-capture.js'

const producers = [
  {
    signature: 'shared.capture_memory_relay_events()',
    previousDigests: ['9994082cfa6f1bba3789d62f4483a11946c45b06da0033f3036c52d60b1a4ac2'],
    ddl: RELAY_EVENT_CAPTURE_FUNCTION,
  },
  {
    signature: 'shared.capture_turn_dialogue()',
    previousDigests: ['1e9275f6ef5741f2c4c754aff243c79ed70c339bf97721903cddac3aaff89557', '82d4418f8df3023b026739db629e04e3525c228a71f0b6c2edca034c812c46e2'],
    ddl: TURN_DIALOGUE_CAPTURE_FUNCTION,
  },
]

// Existing native installations need only these two bodies. CREATE OR REPLACE
// preserves each producer's OID, owner, grants and attached statement triggers.
export async function upgradeEventCapture(pool: pg.Pool): Promise<void> {
  const db = await pool.connect()
  try {
    await db.query("BEGIN; SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='5s'")
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('shared-source-contract-v1',0))")
    for (const { signature, previousDigests, ddl } of producers) {
      const body = ddl.split('$$')[1]
      const { rows } = await db.query(
        `SELECT p.prosrc = $2 AS current, encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') = ANY($3::text[]) AS previous
         FROM pg_proc p WHERE p.oid = to_regprocedure($1) AND p.prosecdef AND p.prorettype = 'trigger'::regtype
           AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
           AND p.proconfig = ARRAY['search_path=pg_catalog, shared']`,
        [signature, body, previousDigests],
      )
      if (rows[0]?.current) continue
      if (!rows[0]?.previous) throw Error('unrecognized_event_capture_producer: ' + signature)
      await db.query(ddl)
    }
    await db.query('COMMIT')
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  } finally {
    db.release()
  }
}
