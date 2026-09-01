import { useTranslation, LOCALES } from '@/i18n'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export function LanguageSwitcher() {
  const { locale, setLocale } = useTranslation()
  return (
    <Select value={locale} onValueChange={(v) => setLocale(v as typeof locale)}>
      <SelectTrigger size="sm" className="h-7 w-[84px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {LOCALES.map((l) => (
          <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
