/** Shared context-domain types (plan sections 6.4, 7.2, 9.3). */

export type ContextMode = 'off' | 'shadow' | 'enabled'

export const CONTEXT_MODE_ORDER: Record<ContextMode, number> = {
  off: 0,
  shadow: 1,
  enabled: 2,
}

/** The effective mode is the minimum across every layer that applies. */
export function minContextMode(modes: readonly ContextMode[]): ContextMode {
  return modes.reduce<ContextMode>(
    (lowest, mode) => (CONTEXT_MODE_ORDER[mode] < CONTEXT_MODE_ORDER[lowest] ? mode : lowest),
    'enabled',
  )
}

export interface ContextSettingsRow {
  settingId: string
  installationId: string
  scopeKind: 'installation' | 'repository' | 'session'
  scopeKey: string
  agent: string | null
  mode: ContextMode
  maxTokens: number | null
  revision: number
}

export interface EffectiveContextSettings {
  mode: ContextMode
  maxTokens: number | null
  revisions: number[]
}

export type LoadoutAssetKind = 'claim' | 'persona' | 'runbook' | 'wiki' | 'skill'
export type LoadoutRepresentation = 'summary' | 'on_demand' | 'reference'

export interface LoadoutItemInput {
  itemId: string
  assetKind: LoadoutAssetKind
  claimId: string | null
  externalAssetRef: string | null
  representation: LoadoutRepresentation
  priority: number
}

export interface ResolvedLoadoutItem {
  itemId: string
  assetKind: LoadoutAssetKind
  representation: LoadoutRepresentation
  priority: number
  claimId: string | null
  /** Wiki/Skill references stay inert until their governed resolvers exist. */
  status: 'resolved' | 'asset_unavailable' | 'claim_inactive'
  claimType: string | null
  versionId: string | null
}

export interface ScopeResolution {
  installationId: string
  repositoryId: string | null
  /** A hint that matches no Installation-owned repository narrows to Persona. */
  repositoryKnown: boolean
  personaOnly: boolean
  sessionKnown: boolean
}
