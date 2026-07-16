export type SupportedLanguage = 'zh' | 'en'

function normalize(value: unknown): SupportedLanguage | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return value.trim().toLowerCase().replace('_', '-').startsWith('zh') ? 'zh' : 'en'
}

export function resolveLanguage(bodyLang?: unknown, acceptLanguage?: unknown): SupportedLanguage {
  return normalize(bodyLang) ?? normalize(acceptLanguage) ?? 'en'
}
