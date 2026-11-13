import {TABLE_POLICY} from '../shared-source/table-policy.js'

const metadataTableVersions:Readonly<Record<string,number>>={memory_canonical_projection_progress:92,memory_team_semantic_groups:94,memory_team_semantic_witnesses:94,memory_team_semantic_publications:96,memory_native_control_observations:97,memory_source_delivery_receipts:Infinity,memory_source_snapshot_receipts:Infinity}
/** Reviewed additive schema roster. Older sources do not acquire tables merely
 * because the destination supports preparatory semantic metadata. */
export function memoryForwardTableRoster(version:number):string[]{
 if(!Number.isInteger(version)||version<84||version>96)throw Error('unreviewed_memory_schema_version')
 return Object.keys(TABLE_POLICY).filter(name=>version>=(metadataTableVersions[name]??84)).sort()
}
