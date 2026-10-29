import type pg from 'pg'
import { deliveryVersionAvailableSql } from '../episodes/delivery-withdrawal.js'

/** SQL identifiers/clock expressions are internal constants, never request input.
 * JSON access preserves reads of the pre-expand schema. A NULL interval is a
 * legacy revision; only its current pointer is consumable without as-of input.
 * Fact validity is independent and must be checked by each consumer. */
export function revisionTimeSql(version='v',at='clock_timestamp()'):string {
 return `(COALESCE((to_jsonb(${version})->>'effective_from')::timestamptz,${version}.created_at)<=${at}
  AND ((to_jsonb(${version})->>'effective_until')::timestamptz IS NULL OR (to_jsonb(${version})->>'effective_until')::timestamptz>${at}))`
}
export function currentClaimVersionSql(claim='c',version='v',at='clock_timestamp()'):string {
 return `(${claim}.current_version_id=${version}.version_id AND ${claim}.claim_id=${version}.claim_id
  AND ${claim}.installation_id=${version}.installation_id AND ${revisionTimeSql(version,at)} AND ${deliveryVersionAvailableSql(version)})`
}
/** Latest committed revision at a half-open boundary, before checking facts.
 * Never fall back to an older statement when the chosen revision's facts fail.
 * The current head bounds committed versions; prepared Git versions are hidden.
 * Reversed historical clocks require migration review rather than invented time. */
export function asOfClaimVersionSql(claim='c',version='v',at='search_clock.as_of'):string {
 return `(${revisionTimeSql(version,at)} AND ${deliveryVersionAvailableSql(version)} AND EXISTS(SELECT 1 FROM knowledge_versions revision_head
  WHERE revision_head.installation_id=${claim}.installation_id AND revision_head.claim_id=${claim}.claim_id
   AND revision_head.version_id=${claim}.current_version_id AND ${version}.version_number<=revision_head.version_number
   AND NOT EXISTS(SELECT 1 FROM knowledge_versions later
    WHERE later.installation_id=${version}.installation_id AND later.claim_id=${version}.claim_id
     AND later.version_number>${version}.version_number AND later.version_number<=revision_head.version_number
     AND COALESCE((to_jsonb(later)->>'effective_from')::timestamptz,later.created_at)<=${at})
   AND NOT EXISTS(SELECT 1 FROM knowledge_versions earlier JOIN knowledge_versions subsequent
    ON subsequent.installation_id=earlier.installation_id AND subsequent.claim_id=earlier.claim_id
     AND subsequent.version_number=earlier.version_number+1
    WHERE earlier.installation_id=${claim}.installation_id AND earlier.claim_id=${claim}.claim_id
     AND subsequent.version_number<=revision_head.version_number
     AND COALESCE((to_jsonb(earlier)->>'effective_from')::timestamptz,earlier.created_at)
       >COALESCE((to_jsonb(subsequent)->>'effective_from')::timestamptz,subsequent.created_at))))`
}

export class ClaimVersionIntervalError extends Error {
 constructor(){super('revision_interval_requires_review')}
}
/** Caller owns the Claim row and transaction. Keep PostgreSQL microseconds as
 * text; JS Date truncation would collapse consecutive revision boundaries.
 * Only the predecessor of this live revision is bridged; no historical sweep. */
export async function activateRevisionInterval(client:pg.PoolClient,input:{installationId:string;claimId:string;previousVersionId:string;versionId:string}):Promise<void>{
 const previous=(await client.query<{boundary:string;eligible:boolean}>(`SELECT
   GREATEST(clock_timestamp(),COALESCE(effective_from,created_at)+interval '1 microsecond')::text AS boundary,
   (effective_until IS NULL AND COALESCE(effective_from,created_at)<=clock_timestamp()) AS eligible
  FROM knowledge_versions WHERE installation_id=$1 AND claim_id=$2 AND version_id=$3`,
 [input.installationId,input.claimId,input.previousVersionId])).rows[0]
 if(!previous?.eligible)throw new ClaimVersionIntervalError()
 const old=await client.query(`UPDATE knowledge_versions SET effective_from=COALESCE(effective_from,created_at),effective_until=$4::timestamptz
  WHERE installation_id=$1 AND claim_id=$2 AND version_id=$3 AND effective_until IS NULL`,
 [input.installationId,input.claimId,input.previousVersionId,previous.boundary])
 const next=await client.query(`UPDATE knowledge_versions SET effective_from=$4::timestamptz,effective_until=NULL
  WHERE installation_id=$1 AND claim_id=$2 AND version_id=$3 AND version_id<>$5::uuid AND effective_from IS NULL AND effective_until IS NULL`,
 [input.installationId,input.claimId,input.versionId,previous.boundary,input.previousVersionId])
 if(old.rowCount!==1||next.rowCount!==1)throw new ClaimVersionIntervalError()
}
