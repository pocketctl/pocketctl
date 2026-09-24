import { randomUUID } from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { verifyAccessTokenWithRevocation } from '../auth.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Queryable = Pick<pg.PoolClient, 'query'>;
class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const bad = (message: string): never => { throw new ApiError(400, message); };
const missing = (): never => { throw new ApiError(404, 'not found'); };
const conflict = (): never => { throw new ApiError(409, 'organization changed; refresh and retry'); };
const validProject = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const cleanName = (value: unknown): string => {
  if (typeof value !== 'string') return bad('name is required');
  const name = value.trim();
  if (!name || [...name].length > 36) return bad('name must contain 1–36 characters');
  return name;
};
async function transaction<T>(pool: pg.Pool, userId: number, action: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [47011, userId]);
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function settings(db: Queryable, userId: number) {
  const result = await db.query(`INSERT INTO session_organization_settings(user_id) VALUES($1)
    ON CONFLICT(user_id) DO UPDATE SET user_id = EXCLUDED.user_id
    RETURNING *`, [userId]);
  return result.rows[0];
}
async function project(db: Queryable, userId: number, projectId: string) {
  const row = (await db.query('SELECT * FROM session_projects WHERE user_id=$1 AND id=$2', [userId, projectId])).rows[0];
  if (!row) missing();
  return row;
}
async function session(db: Queryable, userId: number, sessionId: string) {
  const row = (await db.query(`SELECT * FROM sessions WHERE user_id=$1 AND session_id=$2 AND COALESCE(is_subagent,false)=false`, [userId, sessionId])).rows[0];
  if (!row) missing();
  return row;
}
function bucketWhere(projectId: string | null): string { return projectId ? 'project_id=$2' : 'project_id IS NULL'; }
async function bucketRevision(db: Queryable, userId: number, projectId: string | null) {
  if (projectId) {
    const p = await project(db, userId, projectId);
    return { mode: p.order_mode as string, revision: Number(p.revision) };
  }
  const s = await settings(db, userId);
  return { mode: s.ungrouped_order_mode as string, revision: Number(s.ungrouped_revision) };
}
async function bumpBucket(db: Queryable, userId: number, projectId: string | null) {
  if (projectId) await db.query('UPDATE session_projects SET revision=revision+1, updated_at=NOW() WHERE user_id=$1 AND id=$2', [userId, projectId]);
  else await db.query('UPDATE session_organization_settings SET ungrouped_revision=ungrouped_revision+1 WHERE user_id=$1', [userId]);
}
async function nextTopRank(db: Queryable, userId: number, projectId: string | null, pinned: boolean): Promise<number> {
  const result = await db.query(`SELECT MIN(manual_rank) AS rank FROM sessions WHERE user_id=$1 AND ${bucketWhere(projectId)}
    AND pinned=$${projectId ? 3 : 2} AND archived_at IS NULL AND COALESCE(is_subagent,false)=false`,
    projectId ? [userId, projectId, pinned] : [userId, pinned]);
  return Number(result.rows[0]?.rank ?? 1024) - 1024;
}
function encodeCursor(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeCursor(value: unknown): any {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 1024) return bad('invalid cursor');
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { return bad('invalid cursor'); }
}
async function addChildren(pool: pg.Pool, rows: any[]): Promise<any[]> {
  if (rows.length === 0) return rows;
  const children = await pool.query(`SELECT parent_session_id,agent_id,kind,agent_type,title,status,token_in,token_out,token_cache,token_cache_create
    FROM subagents WHERE parent_session_id=ANY($1::varchar[]) ORDER BY created_at ASC`, [rows.map(row => row.session_id)]);
  const byParent = new Map<string, any[]>();
  for (const child of children.rows) {
    const list = byParent.get(child.parent_session_id) ?? [];
    list.push({ agentId: child.agent_id, kind:child.kind, agentType:child.agent_type, title:child.title,
      status:child.status, tokenIn:Number(child.token_in || 0), tokenOut:Number(child.token_out || 0),
      tokenCache:Number(child.token_cache || 0), tokenCacheCreate:Number(child.token_cache_create || 0) });
    byParent.set(child.parent_session_id,list);
  }
  return rows.map(row => {
    const items = byParent.get(row.session_id) ?? [];
    const childTokens = items.reduce((sum, child) => sum + child.tokenIn + child.tokenOut + child.tokenCache + child.tokenCacheCreate, 0);
    return { ...row, children:items, subagent_count:items.length,
      totalTokens:Number(row.total_tokens || 0) + childTokens,
      tokInput:Number(row.tok_input || 0), tokOutput:Number(row.tok_output || 0),
      tokCacheRead:Number(row.tok_cache_read || 0), tokCacheCreate:Number(row.tok_cache_create || 0) };
  });
}
function listFilter(query: any) {
  const archived = query.view === 'archived';
  const search = query.view === 'active' && typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
  const bucket = archived || search ? null : query.bucket === 'ungrouped' ? null : query.bucket;
  if (!archived && !search && query.bucket !== 'ungrouped' && !validProject(bucket)) bad('invalid bucket');
  if (query.daemon_id != null && (typeof query.daemon_id !== 'string' || query.daemon_id.length > 64)) bad('invalid daemon_id');
  const limit = query.limit == null ? 30 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) bad('invalid limit');
  return { archived, search, bucket: bucket as string | null, daemonId: query.daemon_id || null, limit };
}

export function registerSessionOrganizationRoutes(app: FastifyInstance, options: {
  pool: pg.Pool;
  broadcast: (userId: number, payload: object) => void;
}): void {
  const { pool, broadcast } = options;
  async function auth(req: FastifyRequest, reply: FastifyReply): Promise<number | null> {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) { reply.code(401).send({ error: 'authorization required' }); return null; }
    const token = await verifyAccessTokenWithRevocation(header.slice(7), pool);
    if (!token) { reply.code(401).send({ error: 'invalid token' }); return null; }
    return token.userId;
  }
  async function run(req: FastifyRequest, reply: FastifyReply, action: (userId: number) => Promise<unknown>) {
    const userId = await auth(req, reply);
    if (userId == null) return;
    try { return await action(userId); }
    catch (error: any) {
      const status = error instanceof ApiError ? error.status : error?.code === '23505' ? 409 : 500;
      if (status === 500) req.log.error({ err: error }, 'session organization failed');
      reply.code(status); return { error: status === 500 ? 'internal error' : error.message };
    }
  }
  const changed = (userId: number, extra: object = {}) => broadcast(userId, { type: 'session_organization_changed', ...extra });

  app.get('/api/session-projects', (req, reply) => run(req, reply, async userId => {
    const daemonId = (req.query as any)?.daemon_id || null;
    if (daemonId !== null && (typeof daemonId !== 'string' || daemonId.length > 64)) bad('invalid daemon_id');
    const [projects, counts, archive, currentSettings] = await Promise.all([
      pool.query('SELECT id,name,sort_position,order_mode,revision FROM session_projects WHERE user_id=$1 ORDER BY sort_position,id', [userId]),
      pool.query(`SELECT project_id,COUNT(*)::int AS count FROM sessions WHERE user_id=$1 AND archived_at IS NULL
        AND COALESCE(is_subagent,false)=false AND session_id NOT LIKE 'pending-%' AND ($2::text IS NULL OR daemon_id=$2)
        GROUP BY project_id`, [userId, daemonId]),
      pool.query(`SELECT COUNT(*)::int AS count FROM sessions WHERE user_id=$1 AND archived_at IS NOT NULL
        AND COALESCE(is_subagent,false)=false AND ($2::text IS NULL OR daemon_id=$2)`, [userId, daemonId]),
      pool.query('SELECT * FROM session_organization_settings WHERE user_id=$1', [userId]),
    ]);
    const byId = new Map(counts.rows.map(row => [row.project_id, row.count]));
    return { projects: projects.rows.map(row => ({ ...row, count: byId.get(row.id) ?? 0 })),
      ungrouped_count: byId.get(null) ?? 0, archived_count: archive.rows[0].count,
      project_order_revision: Number(currentSettings.rows[0]?.project_order_revision ?? 0),
      ungrouped_revision: Number(currentSettings.rows[0]?.ungrouped_revision ?? 0),
      ungrouped_order_mode: currentSettings.rows[0]?.ungrouped_order_mode ?? 'activity' };
  }));
  app.post('/api/session-projects', (req, reply) => run(req, reply, async userId => {
    const name = cleanName((req.body as any)?.name);
    const result = await transaction(pool, userId, async db => {
      await settings(db, userId);
      const position = (await db.query('SELECT COALESCE(MAX(sort_position),0)+1024 AS position FROM session_projects WHERE user_id=$1', [userId])).rows[0].position;
      const id = randomUUID();
      await db.query('INSERT INTO session_projects(id,user_id,name,sort_position) VALUES($1,$2,$3,$4)', [id, userId, name, position]);
      await db.query('UPDATE session_organization_settings SET project_order_revision=project_order_revision+1 WHERE user_id=$1', [userId]);
      return { id, name, sort_position: position, order_mode: 'activity', count: 0 };
    });
    reply.code(201); changed(userId, { project_id: result.id }); return result;
  }));
  app.patch('/api/session-projects/:id', (req, reply) => run(req, reply, async userId => {
    const id = (req.params as any).id; if (!validProject(id)) missing();
    const name = cleanName((req.body as any)?.name);
    const expected = (req.body as any)?.expected_revision;
    if (!Number.isSafeInteger(expected) || expected < 0) bad('invalid project revision');
    const row = (await pool.query('UPDATE session_projects SET name=$3,updated_at=NOW(),revision=revision+1 WHERE user_id=$1 AND id=$2 AND revision=$4 RETURNING id,name,revision', [userId, id, name, expected])).rows[0];
    if (!row) { await project(pool,userId,id); conflict(); }
    changed(userId, { project_id: id }); return row;
  }));
  app.put('/api/session-projects/order', (req, reply) => run(req, reply, async userId => {
    const body = req.body as any; const ids = body?.project_ids; const expected = body?.expected_revision;
    if (!Array.isArray(ids) || !ids.every(validProject) || new Set(ids).size !== ids.length || !Number.isSafeInteger(expected)) bad('invalid project order');
    const revision = await transaction(pool, userId, async db => {
      const s = await settings(db, userId);
      if (Number(s.project_order_revision) !== expected) conflict();
      const rows = (await db.query('SELECT id FROM session_projects WHERE user_id=$1', [userId])).rows;
      if (rows.length !== ids.length || rows.some(row => !ids.includes(row.id))) bad('project set mismatch');
      for (let index=0; index<ids.length; index++) await db.query('UPDATE session_projects SET sort_position=$3,updated_at=NOW() WHERE user_id=$1 AND id=$2', [userId, ids[index], (index+1)*1024]);
      return (await db.query('UPDATE session_organization_settings SET project_order_revision=project_order_revision+1 WHERE user_id=$1 RETURNING project_order_revision', [userId])).rows[0].project_order_revision;
    });
    changed(userId); return { revision: Number(revision) };
  }));
  app.get('/api/organized-sessions', (req, reply) => run(req, reply, async userId => {
    const filter = listFilter(req.query as any);
    const { archived, search, bucket, daemonId, limit } = filter;
    const modeInfo = archived || search ? { mode: 'activity', revision: 0 } : await bucketRevision(pool, userId, bucket);
    const fingerprint = JSON.stringify([archived, search, bucket, daemonId, modeInfo.mode, modeInfo.revision]);
    const cursor = decodeCursor((req.query as any)?.cursor);
    if (cursor && (cursor.v !== 1 || cursor.f !== fingerprint || typeof cursor.id !== 'string' || typeof cursor.p !== 'number' || typeof cursor.key !== 'string'
      || (!archived && modeInfo.mode !== 'manual' && typeof cursor.pinAt !== 'string'))) conflict();
    const params: any[] = [userId];
    let where = `s.user_id=$1 AND COALESCE(s.is_subagent,false)=false AND s.session_id NOT LIKE 'pending-%'`;
    if (archived) where += ' AND s.archived_at IS NOT NULL';
    else where += ' AND s.archived_at IS NULL';
    if (!archived && !search) { if (bucket) { params.push(bucket); where += ` AND s.project_id=$${params.length}`; } else where += ' AND s.project_id IS NULL'; }
    if (daemonId) { params.push(daemonId); where += ` AND s.daemon_id=$${params.length}`; }
    if (search) { params.push(`%${search.replaceAll('%','\\%').replaceAll('_','\\_')}%`); where += ` AND (s.title ILIKE $${params.length} OR s.cwd ILIKE $${params.length}
      OR s.session_id ILIKE $${params.length} OR s.agent_type ILIKE $${params.length} OR s.model ILIKE $${params.length})`; }
    let order: string; let key: string; let cursorPredicate: string;
    if (archived) {
      key = `s.archived_at`; order = `${key} DESC,s.session_id DESC`;
      cursorPredicate = `(${key},s.session_id)<($CURSOR_KEY::timestamptz,$CURSOR_ID)`;
    } else if (modeInfo.mode === 'manual' && !search) {
      key = `COALESCE(s.manual_rank,9223372036854775807)`; order = `s.pinned DESC,${key} ASC,s.session_id ASC`;
      cursorPredicate = `(CASE WHEN s.pinned THEN 1 ELSE 0 END < $CURSOR_PIN OR ((CASE WHEN s.pinned THEN 1 ELSE 0 END) = $CURSOR_PIN AND (${key},s.session_id)>($CURSOR_KEY::bigint,$CURSOR_ID)))`;
    } else {
      key = `GREATEST(COALESCE(s.last_activity_at,s.created_at),s.created_at,COALESCE(s.membership_changed_at,s.created_at))`;
      order = `s.pinned DESC,COALESCE(s.pinned_at,'1970-01-01T00:00:00Z'::timestamptz) DESC,${key} DESC,s.session_id DESC`;
      cursorPredicate = `((CASE WHEN s.pinned THEN 1 ELSE 0 END),COALESCE(s.pinned_at,'1970-01-01T00:00:00Z'::timestamptz),${key},s.session_id)
        <($CURSOR_PIN,$CURSOR_PIN_AT::timestamptz,$CURSOR_KEY::timestamptz,$CURSOR_ID)`;
    }
    if (cursor) {
      const pinParam = archived ? null : (params.push(cursor.p), `$${params.length}`);
      const pinAtParam = !archived && modeInfo.mode !== 'manual' ? (params.push(cursor.pinAt), `$${params.length}`) : null;
      params.push(cursor.key); const keyParam = `$${params.length}`;
      params.push(cursor.id); const idParam = `$${params.length}`;
      where += ' AND ' + cursorPredicate.replaceAll('$CURSOR_PIN_AT', pinAtParam ?? '')
        .replaceAll('$CURSOR_PIN', pinParam ?? '')
        .replaceAll('$CURSOR_KEY', keyParam).replaceAll('$CURSOR_ID', idParam);
    }
    params.push(limit+1);
    const result = await pool.query(`SELECT s.session_id,s.daemon_id,s.agent_type,s.active_agent,s.cwd,s.title,s.source,s.status,s.control_mode,s.capabilities,
      s.codex_home_id,s.codex_home_label,s.created_at,s.updated_at,s.last_activity_at,s.turn_started_at,s.exit_reason,s.subagent_count,
      s.pinned,s.pinned_at,s.project_id,s.archived_at,s.manual_rank,s.new_badge_pending,s.model,s.effort,s.parent_session_id,s.is_subagent,s.root_session_id,
      s.total_tokens,s.tok_input,s.tok_output,s.tok_cache_read,s.tok_cache_create,d.status AS daemon_status,d.hostname,d.alias AS daemon_alias,
      p.name AS project_name,${key} AS cursor_key
      FROM sessions s LEFT JOIN daemons d ON d.daemon_id=s.daemon_id LEFT JOIN session_projects p ON p.id=s.project_id
      WHERE ${where} ORDER BY ${order} LIMIT $${params.length}`, params);
    const rows = result.rows.slice(0,limit);
    const last = rows.at(-1);
    const serialized = await addChildren(pool, rows);
    return { sessions: serialized.map(row => ({ ...row, daemon_online: row.daemon_status === 'online', daemon_status: undefined,
      cursor_key: undefined })), has_more: result.rows.length > limit,
      next_cursor: result.rows.length > limit && last ? encodeCursor({ v:1,f:fingerprint,p:last.pinned ? 1 : 0,
        pinAt:last.pinned_at ? new Date(last.pinned_at).toISOString() : '1970-01-01T00:00:00.000Z',
        key:last.cursor_key instanceof Date ? last.cursor_key.toISOString() : String(last.cursor_key),id:last.session_id }) : null,
      revision: modeInfo.revision, order_mode: modeInfo.mode };
  }));
  app.get('/api/sessions/:id/summary', (req, reply) => run(req, reply, async userId => {
    const id = (req.params as any).id;
    const row = (await pool.query(`SELECT s.*,d.hostname,d.alias AS daemon_alias,p.name AS project_name FROM sessions s
      LEFT JOIN daemons d ON d.daemon_id=s.daemon_id LEFT JOIN session_projects p ON p.id=s.project_id
      WHERE s.user_id=$1 AND s.session_id=$2`, [userId,id])).rows[0];
    if (!row) missing(); return (await addChildren(pool,[row]))[0];
  }));
  app.put('/api/sessions/:id/project', (req, reply) => run(req, reply, async userId => {
    const id = (req.params as any).id; const target = (req.body as any)?.project_id;
    if (target !== null && !validProject(target)) bad('invalid project_id');
    const result = await transaction(pool,userId,async db => {
      const current = await session(db,userId,id);
      if (target) await project(db,userId,target);
      if (current.project_id === target) return { project_id: target, revision: Number(current.organization_revision) };
      const targetMode = await bucketRevision(db,userId,target);
      const rank = targetMode.mode === 'manual' ? await nextTopRank(db,userId,target,current.pinned) : null;
      const row = (await db.query(`UPDATE sessions SET project_id=$3,manual_rank=$4,membership_changed_at=NOW(),organization_revision=organization_revision+1
        WHERE user_id=$1 AND session_id=$2 RETURNING organization_revision`,[userId,id,target,rank])).rows[0];
      await bumpBucket(db,userId,current.project_id); await bumpBucket(db,userId,target);
      return { project_id: target, revision: Number(row.organization_revision) };
    });
    changed(userId,{ session_id:id, project_id:target }); return result;
  }));
  app.put('/api/sessions/:id/archive', (req, reply) => run(req, reply, async userId => {
    const id = (req.params as any).id; const archived = (req.body as any)?.archived;
    if (typeof archived !== 'boolean') bad('archived must be boolean');
    const result = await transaction(pool,userId,async db => {
      const current = await session(db,userId,id);
      if (!!current.archived_at === archived) return { archived, archived_at:current.archived_at, project_id:current.project_id };
      const row = (await db.query(`UPDATE sessions SET archived_at=CASE WHEN $3 THEN NOW() ELSE NULL END,organization_revision=organization_revision+1
        WHERE user_id=$1 AND session_id=$2 RETURNING archived_at`,[userId,id,archived])).rows[0];
      await bumpBucket(db,userId,current.project_id);
      return { archived, archived_at:row.archived_at, project_id:current.project_id };
    });
    changed(userId,{ session_id:id, archived }); return result;
  }));
  app.put('/api/sessions/:id/seen', (req, reply) => run(req, reply, async userId => {
    const id = (req.params as any).id;
    const row = (await pool.query(`UPDATE sessions SET new_badge_pending=false,new_badge_seen_at=COALESCE(new_badge_seen_at,NOW()) WHERE user_id=$1 AND session_id=$2
      RETURNING project_id`,[userId,id])).rows[0];
    if (!row) missing(); changed(userId,{ session_id:id, seen:true }); return { seen:true };
  }));
  app.put('/api/session-order', (req, reply) => run(req, reply, async userId => {
    const body = req.body as any; const bucket = body?.bucket === 'ungrouped' ? null : body?.bucket;
    if (bucket !== null && !validProject(bucket)) bad('invalid bucket');
    if (typeof body?.session_id !== 'string' || (body.before_id !== null && body.before_id !== undefined && typeof body.before_id !== 'string') || !Number.isSafeInteger(body.expected_revision)) bad('invalid session order');
    const revision = await transaction(pool,userId,async db => {
      const state = await bucketRevision(db,userId,bucket);
      if (state.revision !== body.expected_revision) conflict();
      const rows = (await db.query(`SELECT session_id,pinned FROM sessions WHERE user_id=$1 AND ${bucketWhere(bucket)}
        AND archived_at IS NULL AND COALESCE(is_subagent,false)=false AND session_id NOT LIKE 'pending-%'
        ORDER BY pinned DESC,${state.mode === 'manual' ? 'manual_rank ASC NULLS LAST,session_id ASC' : 'pinned_at DESC NULLS LAST,GREATEST(COALESCE(last_activity_at,created_at),created_at,COALESCE(membership_changed_at,created_at)) DESC,session_id DESC'}`,
        bucket ? [userId,bucket] : [userId])).rows;
      const moving = rows.find(row => row.session_id === body.session_id);
      if (!moving) missing();
      const before = body.before_id ? rows.find(row => row.session_id === body.before_id) : null;
      if (body.before_id && (!before || before.pinned !== moving.pinned)) bad('target must be in the same pin tier');
      const tier = rows.filter(row => row.pinned === moving.pinned && row.session_id !== moving.session_id);
      const at = before ? tier.findIndex(row => row.session_id === before.session_id) : tier.length;
      tier.splice(at,0,moving);
      const ordered = moving.pinned ? [...tier,...rows.filter(row => !row.pinned)] : [...rows.filter(row => row.pinned),...tier];
      for (let index=0; index<ordered.length; index++) await db.query('UPDATE sessions SET manual_rank=$3 WHERE user_id=$1 AND session_id=$2',[userId,ordered[index].session_id,(index+1)*1024]);
      if (bucket) await db.query(`UPDATE session_projects SET order_mode='manual' WHERE user_id=$1 AND id=$2`,[userId,bucket]);
      else await db.query(`UPDATE session_organization_settings SET ungrouped_order_mode='manual' WHERE user_id=$1`,[userId]);
      await bumpBucket(db,userId,bucket);
      return (await bucketRevision(db,userId,bucket)).revision;
    });
    changed(userId,{ bucket:bucket || 'ungrouped' }); return { revision };
  }));
}
