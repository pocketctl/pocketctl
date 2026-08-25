/**
 * Future port: large-asset object storage. Phase 0 defines the interface
 * only — no cloud implementation exists yet.
 */
export interface ObjectStore {
  put(key: string, body: Uint8Array, signal: AbortSignal): Promise<{ etag: string }>
  get(key: string, signal: AbortSignal): Promise<Uint8Array | null>
  deletePrefix(prefix: string, signal: AbortSignal): Promise<void>
}
