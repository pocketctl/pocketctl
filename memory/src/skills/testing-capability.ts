/** Construction-only authority. Never accept or deserialize this from an API request. */
const capability = Object.freeze({ purpose: 'isolated-skill-fixture' as const })
export type SkillFixtureCapability = typeof capability
export function createSkillFixtureCapability(): SkillFixtureCapability { return capability }
export function hasSkillFixtureCapability(value: unknown): boolean { return value === capability }
