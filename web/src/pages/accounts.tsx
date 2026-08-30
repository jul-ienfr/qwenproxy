import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Fingerprint, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { api, fmtSec, type Account, type AccountFingerprint, type FingerprintProfile } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [inUse, setInUse] = useState<string[]>([])
  const [maxLoad, setMaxLoad] = useState(2)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [fp, setFp] = useState<AccountFingerprint | null>(null)
  const [fpLoading, setFpLoading] = useState(false)

  function LoadBar({ value }: { value: number }) {
    const pct = Math.min(100, (value / Math.max(1, maxLoad)) * 100)
    const tone = pct >= 80 ? 'bg-red-500' : pct >= 50 ? 'bg-amber-400' : 'bg-emerald-400'
    return (
      <div className="ml-auto flex w-28 items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div className={`h-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
        </div>
        <span className="font-mono text-xs text-muted-foreground">{value}</span>
      </div>
    )
  }

  const load = useCallback(async () => {
    try {
      const d = await api.accounts()
      setAccounts(d.accounts)
      setInUse(d.inUse)
      if (d.maxStreamsPerAccount) setMaxLoad(d.maxStreamsPerAccount)
    } catch (err: any) {
      toast.error(err?.message || 'Falha ao carregar contas')
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])

  async function add() {
    if (!email.trim() || !password) return
    setBusy(true)
    try {
      await api.addAccount(email.trim(), password)
      setEmail('')
      setPassword('')
      toast.success('Conta adicionada')
      load()
    } catch (err: any) {
      toast.error(err?.message || 'Falha ao adicionar')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (!confirm('Remover esta conta?')) return
    await api.removeAccount(id)
    toast.success('Conta removida')
    load()
  }

  async function showFp(id: string) {
    setFpLoading(true)
    try {
      setFp(await api.accountFingerprint(id))
    } catch (err: any) {
      toast.error(err?.message || 'Falha ao carregar fingerprint')
    } finally {
      setFpLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contas Qwen</CardTitle>
          <CardDescription>{accounts.length} conta(s) configurada(s)</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>E-mail</TableHead>
                <TableHead>ID</TableHead>
                <TableHead className="text-right">Carga</TableHead>
                <TableHead className="w-20">Streams</TableHead>
                <TableHead>Cooldown</TableHead>
                <TableHead>Em uso</TableHead>
                <TableHead className="w-28">Fingerprint</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-muted-foreground">
                    Nenhuma conta — adicione abaixo
                  </TableCell>
                </TableRow>
              ) : (
                accounts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.email}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{a.id.slice(0, 8)}…</TableCell>
                    <TableCell className="text-right">
                      <LoadBar value={a.activeLoad} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{a.streams ?? 0}</TableCell>
                    <TableCell>
                      {a.cooldown > 0 ? (
                        <Badge variant="outline" className="text-amber-400">
                          {fmtSec(a.cooldown / 1000)}
                          {a.cooldownReason ? ` · ${a.cooldownReason}` : ''}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-emerald-400">
                          ok
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Badge variant="outline" className={inUse.includes(a.id) ? 'text-amber-400' : 'text-emerald-400'}>
                          {inUse.includes(a.id) ? 'em uso' : 'livre'}
                        </Badge>
                        <Badge variant="outline" className={a.ready ? 'text-emerald-400' : 'text-amber-400'}>
                          {a.ready ? 'pronta' : 'aquecendo'}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-2"
                        title="Ver fingerprint do dispositivo"
                        onClick={() => showFp(a.id)}
                      >
                        <Fingerprint className={a.cooldownReason === 'CaptchaBlocked' || a.cooldownReason === 'Flagged' ? 'text-amber-400' : 'text-sky-400'} />
                        ver
                      </Button>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => api.clearCooldown(a.id).then(() => { toast.success('Cooldown limpo'); load() })}>
                          <X /> limpar cooldown
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => api.refreshHeaders(a.id).then(() => toast.success('Headers atualizados')).catch((e) => toast.error(e.message))}>
                          <RefreshCw /> headers
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => remove(a.id)}>
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Adicionar conta</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="grid gap-2">
              <Label htmlFor="acc-email">E-mail</Label>
              <Input id="acc-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@qwen.example" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="acc-pass">Senha</Label>
              <Input id="acc-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="senha da conta" />
            </div>
            <Button className="gap-2" disabled={busy || !email.trim() || !password} onClick={add}>
              <Plus /> Adicionar
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={fp !== null} onOpenChange={(o) => { if (!o) setFp(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Fingerprint className="text-sky-400" /> Fingerprint do dispositivo
            </DialogTitle>
            <DialogDescription>
              Identidade do navegador usada por esta conta para driblar a detecção de automação.
              {fp && fp.salt > 0 && ' Sal já rotacionado — esta identidade foi renovada por contingência de bloqueio.'}
            </DialogDescription>
          </DialogHeader>
          {fpLoading || !fp ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Carregando fingerprint…</div>
          ) : (
            <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">salt: {fp.salt}</Badge>
                <Badge variant="outline">versão de identidade: {fp.resourceVersion}</Badge>
              </div>
              <FpProfile profile={fp.profile} />
              {fp.lanes && fp.lanes.length > 0 && (
                <div className="flex flex-col gap-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Lanes isoladas ({fp.lanes.length}) — cada uma com fingerprint próprio
                  </div>
                  {fp.lanes.map((l) => (
                    <div key={l.lane} className="rounded-md border p-3">
                      <div className="mb-2 text-xs font-medium text-muted-foreground">Lane {l.lane} · {l.id}</div>
                      <FpProfile profile={l.profile} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function FpRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b py-1.5 last:border-0">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="text-right font-mono text-xs break-all">{value}</span>
    </div>
  )
}

function FpProfile({ profile }: { profile: FingerprintProfile }) {
  return (
    <div className="rounded-md border p-3">
      <FpRow label="User-Agent" value={profile.userAgent} />
      <FpRow label="Plataforma" value={`${profile.platform} ${profile.platformVersion} (${profile.architecture} ${profile.bitness})`} />
      <FpRow label="Chrome" value={`${profile.chromeVersion} (major ${profile.chromeMajor})`} />
      <FpRow label="Viewport" value={`${profile.viewport.width}×${profile.viewport.height} (outer +${profile.outerWidthOffset}/+${profile.outerHeightOffset})`} />
      <FpRow label="Hardware Concurrency" value={profile.hardwareConcurrency} />
      <FpRow label="Device Memory" value={`${profile.deviceMemory} GB`} />
      <FpRow label="Idiomas" value={profile.languages.join(', ')} />
      <FpRow label="WebGL" value={`${profile.webglVendor} / ${profile.webglRenderer}`} />
      <FpRow label="Color / Pixel depth" value={`${profile.colorDepth} / ${profile.pixelDepth}`} />
      <FpRow label="Canvas noise seed" value={profile.canvasNoiseSeed} />
      <FpRow label="Audio noise seed" value={profile.audioNoiseSeed} />
      <FpRow label="WebGL noise seed" value={profile.webglNoiseSeed} />
    </div>
  )
}
