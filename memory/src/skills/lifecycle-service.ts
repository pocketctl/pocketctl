import type pg from 'pg'
import { createPurgeRepository } from '../purge/repository.js'
import type { TombstoneHmacKey } from '../config.js'
import {createLifecycleService} from '../claims/lifecycle-service.js'
import {createClaimRepository} from '../claims/repository.js'

/** Use existing lifecycle tombstones and locks, rather than inventing an independent replay fence. */
export function createSkillLifecycleService(deps:{pool:pg.Pool;hmacKey:string;tombstoneHmacKeys?:readonly TombstoneHmacKey[]}) {
  const purge=createPurgeRepository(deps.pool,{hmacKey:deps.hmacKey,tombstoneHmacKeys:deps.tombstoneHmacKeys})
  return {
    purgeSession:(input:{installationId:string;sessionId:string;reason:string;sourceFeedId:string|number|null})=>purge.purgeSession(input),
    purgeRepository:purge.purgeRepository,
    purgeSourceSnapshot:purge.purgeSourceSnapshot,
    /** Expiration updates authoritative Claims; their normal invalidation triggers clear dependent Skills. */
    expireSources:()=>createLifecycleService(deps.pool,createClaimRepository(deps.pool)).expireDueClaims(),
  }
}
