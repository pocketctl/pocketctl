import type pg from 'pg'

import { signCapabilityGrantV2, type GrantKeyMaterial, type ScopeBindingV2 } from './capability-grant.js'
import type { ExtensionMode } from './types.js'
import { EXTENSION_PROVIDER_CATALOG } from './catalog.js'
import { permissionsForRoles, normalizeScopeRoles } from './scope-types.js'

/**
 * ADR-P3-05 v2 grant mint service. Relay mints a federated scope grant only
 * for an explicit caller-selected list of at most 16 accessible Memory
 * installations. Every binding derives from the authenticated user's own
 * installations and active memberships inside one SQL boundary — never from
 * request bodies — and carries the current membership revision plus the
 * owning scope's authorization epoch so Memory can reject it the moment a
 * fence advances.
 */

export interface V2GrantMintInput {
  userId: number
  installationIds: string[]
  callerType: 'web' | 'daemon' | 'agent'
  services?: string[]
}

export type V2GrantMintResult =
  | {
      ok: true
      token: string
      expiresInSeconds: number
      providerId: string
      providerPublicOrigin?: string
      bindings: ScopeBindingV2[]
    }
  | {
      ok: false
      code: 'feature_disabled' | 'invalid_request' | 'not_found' | 'forbidden' | 'installation_paused'
      message: string
    }

interface BindingCandidateRow {
  installation_id: string
  provider_id: string
  owner_user_id: number | null
  status: string
  enabled_services: string[]
  config_version: string | number
  owner_scope_kind: 'personal' | 'team' | 'organization'
  owner_scope_id: string
  authorization_epoch: string | number
  membership_id: string | null
  membership_revision: string | number | null
  membership_state: string | null
  roles: string[] | null
}

interface ScopeStateRow {
  scope_kind: 'team' | 'organization'
  scope_id: string
  state: string
  authorization_epoch: string | number
}

const PERSONAL_OWNER_PERMISSIONS = Object.freeze([
  'read', 'contribute', 'review', 'publish', 'policy_admin', 'scope_admin',
])

export interface V2GrantServiceDeps {
  pool: pg.Pool
  issuer: string
  v2Mode: ExtensionMode
  grantKeys: GrantKeyMaterial
  ttlSeconds?: number
  providerPublicOrigins?: ReadonlyMap<string, string>
}

export function createV2GrantService(deps: V2GrantServiceDeps) {
  return {
    async mint(input: V2GrantMintInput): Promise<V2GrantMintResult> {
      if (deps.v2Mode !== 'enabled') {
        return {
          ok: false,
          code: 'feature_disabled',
          message: 'v2 grants require RELAY_EXTENSION_V2=enabled',
        }
      }
      if (!['web', 'daemon', 'agent'].includes(input.callerType)) {
        return { ok: false, code: 'invalid_request', message: 'caller_type must be web, daemon or agent' }
      }
      if (!Array.isArray(input.installationIds)
        || input.installationIds.length === 0
        || input.installationIds.length > 16
        || new Set(input.installationIds).size !== input.installationIds.length
        || input.installationIds.some(id => typeof id !== 'string')) {
        return {
          ok: false,
          code: 'invalid_request',
          message: 'installation_ids must be 1..16 unique identifiers',
        }
      }
      if (input.services
        && (!Array.isArray(input.services)
          || input.services.some(service => typeof service !== 'string'))) {
        return { ok: false, code: 'invalid_request', message: 'services must be a list of service ids' }
      }
      const dispositionOnly = input.services?.length === 1
        && input.services[0] === 'memory.manage'

      {
        {
          const providers = EXTENSION_PROVIDER_CATALOG.map(entry => entry.provider_id)
          const rows = await deps.pool.query<BindingCandidateRow>(`
            SELECT i.installation_id, i.provider_id, i.owner_user_id, i.status,
                   i.enabled_services, i.config_version,
                   i.owner_scope_kind, i.owner_scope_id, i.authorization_epoch,
                   m.membership_id, m.membership_revision, m.state AS membership_state, m.roles
            FROM extension_installations i
            LEFT JOIN extension_scope_memberships m
              ON m.scope_kind = i.owner_scope_kind
             AND m.scope_id = i.owner_scope_id
             AND m.user_id = $1
             AND m.state = 'active'
            WHERE i.installation_id = ANY($2::uuid[])
              AND i.provider_id = ANY($3::text[])
          `, [input.userId, input.installationIds, providers])
          const byId = new Map(rows.rows.map(row => [row.installation_id, row]))

          const scopeIds = {
            team: new Set<string>(),
            organization: new Set<string>(),
          }
          const bindings: ScopeBindingV2[] = []
          for (const installationId of input.installationIds) {
            const row = byId.get(installationId)
            // Foreign, missing, cross-provider, or unauthorized: uniform 404.
            if (!row) {
              return { ok: false, code: 'not_found', message: 'installation not found' }
            }
            if (row.owner_scope_kind === 'personal') {
              if (row.owner_user_id === null || Number(row.owner_user_id) !== input.userId) {
                return { ok: false, code: 'not_found', message: 'installation not found' }
              }
            } else if (row.membership_id === null || row.membership_state !== 'active') {
              return { ok: false, code: 'not_found', message: 'installation not found' }
            } else {
              scopeIds[row.owner_scope_kind].add(row.owner_scope_id)
            }
            if (row.status === 'paused' || row.status === 'pending') {
              return { ok: false, code: 'installation_paused', message: 'installation is not active' }
            }
            if (row.status !== 'active') {
              return { ok: false, code: 'not_found', message: 'installation not found' }
            }
            bindings.push({
              installation_id: row.installation_id,
              owner_scope_kind: row.owner_scope_kind,
              owner_scope_id: row.owner_scope_id,
              membership_id: row.owner_scope_kind === 'personal' ? null : row.membership_id,
              membership_revision: row.owner_scope_kind === 'personal'
                ? '0'
                : String(row.membership_revision),
              authorization_epoch: String(row.authorization_epoch),
              permissions: row.owner_scope_kind === 'personal'
                ? [...PERSONAL_OWNER_PERMISSIONS]
                : [...permissionsForRoles(normalizeScopeRoles(row.roles) ?? [])],
            })
          }

          // Shared scopes must still be live: suspended/dissolving/dissolved
          // scopes mint nothing.
          const scopeKinds: Array<'team' | 'organization'> = ['team', 'organization']
          const pendingLookups = scopeKinds
            .filter(kind => scopeIds[kind].size > 0)
          if (pendingLookups.length > 0) {
            const unionParts: string[] = []
            const params: unknown[] = []
            for (const kind of pendingLookups) {
              const paramIndex = params.length + 1
              params.push([...scopeIds[kind]])
              unionParts.push(kind === 'team'
                ? `SELECT 'team' AS scope_kind, team_id AS scope_id, state, authorization_epoch
                   FROM extension_teams WHERE team_id = ANY($${paramIndex}::uuid[])`
                : `SELECT 'organization' AS scope_kind, organization_id AS scope_id, state, authorization_epoch
                   FROM extension_organizations WHERE organization_id = ANY($${paramIndex}::uuid[])`)
            }
            const scopeRows = await deps.pool.query<ScopeStateRow>(
              unionParts.join(' UNION ALL '),
              params,
            )
            const stateByScope = new Map(scopeRows.rows.map(row => [`${row.scope_kind}:${row.scope_id}`, row]))
            for (const binding of bindings) {
              if (binding.owner_scope_kind === 'personal') continue
              const scope = stateByScope.get(`${binding.owner_scope_kind}:${binding.owner_scope_id}`)
              const dispositionAllowed = dispositionOnly
                && scope?.state === 'dissolving'
                && binding.permissions.includes('scope_admin')
              if (!scope || (scope.state !== 'active' && !dispositionAllowed)) {
                return { ok: false, code: 'not_found', message: 'installation not found' }
              }
              binding.authorization_epoch = String(scope.authorization_epoch)
            }
          }

          const primary = byId.get(input.installationIds[0])!
          const requestedServices = input.services
          const services = requestedServices
            ? requestedServices.filter(service => input.installationIds.every(
              installationId => byId.get(installationId)!.enabled_services.includes(service)))
            : primary.enabled_services.filter(service => input.installationIds.every(
              installationId => byId.get(installationId)!.enabled_services.includes(service)))
          if (requestedServices && services.length !== requestedServices.length) {
            return {
              ok: false,
              code: 'forbidden',
              message: 'requested services are not enabled for this installation',
            }
          }

          const ttl = Math.min(
            Math.max(1, Math.trunc(deps.ttlSeconds ?? 60)),
            60,
          )
          const token = signCapabilityGrantV2(deps.grantKeys, {
            issuer: deps.issuer,
            providerId: primary.provider_id,
            userId: input.userId,
            callerType: input.callerType,
            services,
            primaryInstallationId: primary.installation_id,
            scopeBindings: bindings,
            configVersion: primary.config_version,
            ttlSeconds: ttl,
          })
          // Bounded audit: provider allowlist id and a binding-count category
          // only — never the grant, jti, installation ids, or service list.
          await deps.pool.query(
            `INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3::jsonb)`,
            [input.userId, 'extension_capability_grant_v2', JSON.stringify({
              provider_id: primary.provider_id,
              binding_count: bindings.length,
              caller_type: input.callerType,
            })],
          ).catch(() => undefined)
          return {
            ok: true,
            token,
            expiresInSeconds: ttl,
            providerId: primary.provider_id,
            providerPublicOrigin: deps.providerPublicOrigins?.get(primary.provider_id),
            bindings,
          }
        }
      }
    },
  }
}

export type V2GrantService = ReturnType<typeof createV2GrantService>
