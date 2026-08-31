import type pg from 'pg'

import type { ExtensionScopeFeedEnvelopeV2 } from '../relay/contracts.js'
import { classifyScopeControlEnvelope, validateScopeControlBatch } from '../relay/validation.js'
import type { ScopeMirrorRepository } from './scope-mirror-repository.js'
import { createScopeMirrorRepository } from './scope-mirror-repository.js'

export interface ScopeControlProjectorOptions {
  pool: pg.Pool
  workerId: string
  pullScopeControlFeed(installationId: string, limit: number): Promise<unknown>
  ackScopeControlFeed(input: { installation_id: string; cursor: string; lease_token: string }): Promise<number>
  batchLimit?: number
  mirror?: ScopeMirrorRepository
  onError?(error: unknown): void
}

const DEFAULT_BATCH_LIMIT = 100

function decimalLessThan(left: string, right: string): boolean {
  return BigInt(left) < BigInt(right)
}

function decimalMax(left: string, right: string): string {
  return BigInt(left) >= BigInt(right) ? left : right
}

/**
 * ADR-0005 membership/lifecycle projector. Consumes the extension-feed.v2
 * scope-control stream per shared installation and applies only events that
 * are newer than the local mirror fences (§10.3):
 *
 * - feed idempotency: rows at or below `last_feed_id` are skipped;
 * - membership events apply only when `(authorization_epoch,
 *   membership_revision)` advances over the local row;
 * - lifecycle events advance the scope state/epoch; dissolution records a
 *   tombstone whose epoch defeats every older replayed fact;
 * - boundary validation rejects any batch containing a malformed envelope,
 *   so malformed control facts are never partially projected or ACKed.
 */
export function createScopeControlProjector(options: ScopeControlProjectorOptions) {
  const mirror = options.mirror ?? createScopeMirrorRepository(options.pool)
  const batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT

  async function applyMembership(
    installationId: string,
    envelope: ExtensionScopeFeedEnvelopeV2,
  ): Promise<void> {
    const membershipId = envelope.subject.membership_id!
    const epoch = envelope.owner_scope.authorization_epoch
    const revision = envelope.data.membership_revision as string
    const feedId = envelope.feed_id
    const state = String(envelope.data.state ?? 'active')
    const roles = Array.isArray(envelope.data.roles)
      ? (envelope.data.roles as unknown[]).filter((role): role is string => typeof role === 'string')
      : []
    await options.pool.query(`
      INSERT INTO memory_scope_memberships
        (installation_id, membership_id, roles, state, membership_revision, valid_from, valid_until, last_feed_id)
      VALUES ($1, $2, $3::text[], $4, $5, NOW(), CASE WHEN $4 = 'revoked' THEN NOW() ELSE NULL END, $6)
      ON CONFLICT (installation_id, membership_id) DO UPDATE SET
        roles = EXCLUDED.roles,
        state = EXCLUDED.state,
        membership_revision = GREATEST(memory_scope_memberships.membership_revision, EXCLUDED.membership_revision),
        valid_until = CASE
          WHEN EXCLUDED.state = 'revoked' THEN NOW()
          WHEN memory_scope_memberships.valid_until IS NOT NULL AND EXCLUDED.state <> 'active'
            THEN memory_scope_memberships.valid_until
          WHEN EXCLUDED.state = 'active' THEN NULL
          ELSE memory_scope_memberships.valid_until
        END,
        last_feed_id = GREATEST(memory_scope_memberships.last_feed_id, EXCLUDED.last_feed_id),
        updated_at = NOW()
      WHERE (memory_scope_memberships.membership_revision, memory_scope_memberships.last_feed_id)
            < (EXCLUDED.membership_revision, EXCLUDED.last_feed_id)
         OR memory_scope_memberships.membership_revision < EXCLUDED.membership_revision
    `, [installationId, membershipId, roles, state, revision, feedId])
    await mirror.advanceEpoch({
      installationId,
      authorizationEpoch: epoch,
      lastFeedId: feedId,
    })
  }

  async function applyLifecycle(
    installationId: string,
    envelope: ExtensionScopeFeedEnvelopeV2,
  ): Promise<void> {
    const epoch = envelope.owner_scope.authorization_epoch
    const state = String(envelope.data.state ?? 'active')
    await options.pool.query(`
      UPDATE memory_owner_scopes
      SET state = $2,
          authorization_epoch = GREATEST(authorization_epoch, $3),
          last_feed_id = GREATEST(last_feed_id, $4),
          updated_at = NOW()
      WHERE installation_id = $1
    `, [installationId, state, epoch, envelope.feed_id])
    if (state === 'dissolved') {
      const scope = await mirror.get(installationId)
      if (scope && scope.owner_scope_kind !== 'personal') {
        await mirror.recordTombstone({
          ownerScopeKind: scope.owner_scope_kind,
          ownerScopeId: scope.owner_scope_id,
          authorizationEpoch: epoch,
          reason: state,
        })
      }
    }
  }

  return {
    async consumeInstallation(installationId: string): Promise<{ projected: number; skipped: number }> {
      const scope = await mirror.get(installationId)
      if (!scope || scope.owner_scope_kind === 'personal') return { projected: 0, skipped: 0 }

      const pulled = await options.pullScopeControlFeed(installationId, batchLimit)
      const validatedBatch = validateScopeControlBatch(pulled)
      if (!validatedBatch.ok) {
        throw new Error('scope-control feed returned a malformed batch')
      }
      const batch = validatedBatch.batch
      if (batch.installation_id !== installationId) {
        throw new Error('scope-control feed installation mismatch')
      }
      if (batch.items.some(envelope =>
        envelope.owner_scope.kind !== scope.owner_scope_kind
        || envelope.owner_scope.id !== scope.owner_scope_id)) {
        throw new Error('scope-control feed owner scope mismatch')
      }
      const items = batch.items
      let projected = 0
      let skipped = 0

      for (const raw of items) {
        const decision = classifyScopeControlEnvelope(raw)
        if (decision.kind === 'rejected') {
          skipped++
          continue
        }
        const envelope = decision.envelope
        const feedId = envelope.feed_id
        if (!decimalLessThan(scope.last_feed_id, feedId)) {
          skipped++
          continue
        }
        const epoch = envelope.owner_scope.authorization_epoch
        const tombstoned = await mirror.tombstoneEpochAtLeast({
          ownerScopeKind: envelope.owner_scope.kind,
          ownerScopeId: envelope.owner_scope.id,
          authorizationEpoch: epoch,
        })
        if (tombstoned) {
          skipped++
          await mirror.advanceEpoch({ installationId, authorizationEpoch: '0', lastFeedId: feedId })
          continue
        }
        if (decimalLessThan(epoch, scope.authorization_epoch)) {
          skipped++
          await mirror.advanceEpoch({ installationId, authorizationEpoch: '0', lastFeedId: feedId })
          continue
        }
        if (envelope.topic === 'scope.membership.v2') {
          const membershipId = envelope.subject.membership_id!
          const revision = envelope.data.membership_revision as string
          if (epoch === scope.authorization_epoch) {
            const current = await options.pool.query<{ membership_revision: string }>(
              `SELECT membership_revision::text FROM memory_scope_memberships
               WHERE installation_id = $1 AND membership_id = $2`,
              [installationId, membershipId],
            )
            const localRevision = current.rows[0]?.membership_revision ?? '0'
            if (!decimalLessThan(localRevision, revision)) {
              skipped++
              await mirror.advanceEpoch({ installationId, authorizationEpoch: '0', lastFeedId: feedId })
              continue
            }
          }
          await applyMembership(installationId, envelope)
          projected++
        } else if (envelope.topic === 'scope.lifecycle.v2') {
          await applyLifecycle(installationId, envelope)
          projected++
        } else {
          // scope.installation.v2: informational; advance the watermark only.
          await mirror.advanceEpoch({ installationId, authorizationEpoch: '0', lastFeedId: feedId })
          skipped++
        }
        scope.last_feed_id = decimalMax(scope.last_feed_id, feedId)
        scope.authorization_epoch = decimalMax(scope.authorization_epoch, epoch)
      }

      await options.ackScopeControlFeed({
        installation_id: installationId,
        cursor: batch.next_cursor,
        lease_token: batch.lease_token,
      })
      // Shared installations do not own a personal session feed. Their
      // durable scope-control ACK is therefore the readiness fence that the
      // v1 inbox ACK provides for personal installations.
      await options.pool.query(`
        UPDATE memory_installations
        SET local_status = 'ready', last_error_code = NULL, updated_at = NOW()
        WHERE installation_id = $1
          AND relay_status = 'active'
          AND snapshot_required = FALSE
          AND local_status IN ('discovering', 'syncing')
      `, [installationId])
      return { projected, skipped }
    },

    async runOnce(): Promise<{ installations: number }> {
      const installations = await mirror.listSharedInstallations()
      let consumed = 0
      for (const installation of installations) {
        try {
          const result = await this.consumeInstallation(installation.installation_id)
          if (result.projected + result.skipped > 0) consumed++
        } catch (error) {
          options.onError?.(error)
        }
      }
      return { installations: consumed }
    },
  }
}

export type ScopeControlProjector = ReturnType<typeof createScopeControlProjector>
