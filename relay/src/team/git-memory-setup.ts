import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { createOrganizationWithCreatorInTx } from '../extensions/scope-repository.js'
import { requireTeamAccess } from './access.js'
import { GitProjectError } from './git-projects.js'

/** One atomic, repeatable setup per collaboration Team. Never rebind an existing scope. */
export async function initializeGitTeamMemory(pool: pg.Pool, teamId: string, actor: number) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await requireTeamAccess(client, actor, true)
    const team = (await client.query(`SELECT t.name,t.creator_user_id FROM collaboration_teams t
      JOIN collaboration_team_memberships m USING(team_id) WHERE t.team_id=$1 AND t.state='active'
      AND m.user_id=$2 AND m.state='active' FOR UPDATE OF t FOR SHARE OF m`, [teamId, actor])).rows[0]
    if (!team) throw new GitProjectError('team_access_denied')
    if (team.creator_user_id !== actor) throw new GitProjectError('creator_required')
    const prior = (await client.query(`SELECT installation_id FROM team_memory_bindings WHERE team_id=$1 AND state='active'`, [teamId])).rows[0]
    if (prior) { await client.query('COMMIT'); return { installation_id: prior.installation_id } }
    const provider = (await client.query(`SELECT 1 FROM extension_providers WHERE provider_id='pocketctl-memory' AND status='enabled' FOR SHARE`)).rowCount
    if (!provider) throw new Error('memory_provider_disabled')
    const { organization } = await createOrganizationWithCreatorInTx(client, { name: `${team.name} Memory`, createdByUserId: actor })
    const installation = randomUUID(), scope = organization.organization_id
    await client.query(`INSERT INTO extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,
      created_by_user_id,status,granted_scopes,subscriptions,enabled_services,start_policy,authorization_epoch)
      VALUES($1,'pocketctl-memory','organization',$2,$3,'pending',ARRAY['scope:control:read'],
        ARRAY['scope.lifecycle.v2','scope.membership.v2','scope.installation.v2'],ARRAY['memory.search','memory.manage'],'from_now',$4)`,
    [installation, scope, actor, organization.authorization_epoch])
    await client.query(`INSERT INTO extension_scope_outbox(scope_kind,scope_id,topic,payload)
      VALUES('organization',$1,'scope.installation.v2',$2::jsonb)`, [scope, JSON.stringify({event_type:'installation_created',installation_id:installation,authorization_epoch:organization.authorization_epoch,state:'pending'})])
    await client.query(`INSERT INTO team_memory_bindings(binding_id,team_id,owner_scope_kind,owner_scope_id,installation_id,revision,created_by_user_id)
      VALUES($1,$2,'organization',$3,$4,1,$5)`, [`cmbd_${randomUUID()}`, teamId, scope, installation, actor])
    await client.query('COMMIT')
    return { installation_id: installation }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
