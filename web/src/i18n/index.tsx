import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import ptBR from './locales/pt-BR.json'
import fr from './locales/fr.json'
import en from './locales/en.json'

export type Locale = 'pt-BR' | 'fr' | 'en'
export const LOCALES: { value: Locale; label: string }[] = [
  { value: 'pt-BR', label: 'PT-BR' },
  { value: 'fr', label: 'FR' },
  { value: 'en', label: 'EN' },
]

const dictionaries: Record<Locale, Record<string, string>> = {
  'pt-BR': ptBR as Record<string, string>,
  'fr': fr as Record<string, string>,
  'en': en as Record<string, string>,
}

const STORAGE_KEY = 'qwenproxy-lang'
const DEFAULT_LOCALE: Locale = 'pt-BR'

function getInitialLocale(): Locale {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'pt-BR' || v === 'en' || v === 'fr') return v
  } catch {}
  return DEFAULT_LOCALE
}

type I18nContextValue = {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: string, params?: Record<string, string | number>) => string
  formatNumber: (n: number) => string
  formatTime: (d: Date | number, opts?: Intl.DateTimeFormatOptions) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale)

  const setLocale = (l: Locale) => {
    setLocaleState(l)
    try { localStorage.setItem(STORAGE_KEY, l) } catch {}
  }

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const value = useMemo<I18nContextValue>(() => {
    const dict = dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE]
    const fallback = dictionaries[DEFAULT_LOCALE]
    const t = (key: string, params?: Record<string, string | number>): string => {
      let s: string | undefined = dict[key] ?? fallback[key]
      if (s === undefined) return key
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          s = (s as string).replaceAll(`{${k}}`, String(v))
        }
      }
      return s as string
    }
    const formatNumber = (n: number) => n.toLocaleString(locale)
    const formatTime = (d: Date | number, opts?: Intl.DateTimeFormatOptions) => {
      const date = d instanceof Date ? d : new Date(d)
      if (opts) return date.toLocaleTimeString(locale, opts)
      return date.toLocaleTimeString(locale)
    }
    return { locale, setLocale, t, formatNumber, formatTime }
  }, [locale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useTranslation(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useTranslation must be used within LanguageProvider')
  return ctx
}
