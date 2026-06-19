import { ref } from 'vue'

const STORAGE_KEY = 'pocketctl-locale'
const SUPPORTED = ['zh', 'en'] as const
export type Locale = typeof SUPPORTED[number]

function detectLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY) as Locale | null
  if (saved && SUPPORTED.includes(saved)) return saved
  const nav = (navigator.language || 'zh').toLowerCase()
  return nav.startsWith('zh') ? 'zh' : 'en'
}

const locale = ref<Locale>(detectLocale())

// Translations loaded eagerly (JSON files bundled by Vite resolveStaticUrl)
import zh from '../i18n/zh.json'
import en from '../i18n/en.json'
const translations: Record<Locale, Record<string, string>> = { zh, en }

/**
 * Pocketctl i18n composable — lightweight, no dependencies.
 *
 * Usage:
 *   const { t, locale, setLocale } = useLocale()
 *   t('session.title')  → zh: "会话详情" / en: "Session Detail"
 *
 * Keys are dotted (module.feature.label), matching the JSON structure.
 * Fallback: zh → en → raw key.
 */
export function useLocale() {
  const t = (key: string, params?: Record<string, string | number>): string => {
    let text = translations[locale.value]?.[key] ?? translations.zh[key] ?? key
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.split(`{{${k}}}`).join(String(v))
      }
    }
    return text
  }

  const setLocale = (lang: Locale) => {
    locale.value = lang
    localStorage.setItem(STORAGE_KEY, lang)
    window.dispatchEvent(new CustomEvent('pocketctl-locale-change', { detail: { locale: lang } }))
  }

  return { locale, t, setLocale, SUPPORTED }
}
