'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Plus, Users, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { trpc } from '@/lib/trpc/client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'

const schema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/, 'lowercase letters, numbers, dashes'),
  name: z.string().min(1).max(255),
  departmentId: z.string().uuid().optional().or(z.literal(''))
})

export default function TeamsTab() {
  const params = useParams()
  const orgId = params?.id as string
  const [open, setOpen] = useState(false)
  const utils = trpc.useUtils()
  const { data: teams, isLoading } = trpc.teams.list.useQuery({ orgId })
  const { data: depts } = trpc.departments.list.useQuery({ orgId })
  const { data: session } = trpc.me.session.useQuery()
  const t = useTranslations('teams')
  const tDialog = useTranslations('teamsDialog')
  const tCommon = useTranslations('common')
  const tOrgs = useTranslations('organizations')

  const canCreate =
    session?.assignments.some(
      (a: { role: string; scopeType: string; scopeId: string | null }) =>
        (a.role === 'org_admin' && a.scopeId === orgId) || a.role === 'super_admin' || a.role === 'dept_manager'
    ) ?? false

  const create = trpc.teams.create.useMutation({
    onSuccess: (team) => {
      toast.success(tDialog('createdToast', { name: team?.name ?? '' }))
      setOpen(false)
      reset()
      utils.teams.list.invalidate({ orgId })
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code
      toast.error(code === 'FORBIDDEN' ? tCommon('insufficientPermission') : e.message)
    }
  })

  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema)
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('subtitle')}
        </p>
        {canCreate && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1.5">
                <Plus className="h-4 w-4" />
                {t('newTeam')}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('newTeam')}</DialogTitle>
                <DialogDescription>{tDialog('description')}</DialogDescription>
              </DialogHeader>
              <form
                onSubmit={handleSubmit((v) =>
                  create.mutateAsync({
                    orgId,
                    name: v.name,
                    slug: v.slug,
                    departmentId: v.departmentId || undefined
                  })
                )}
                className="space-y-4"
              >
                <div className="space-y-1.5">
                  <Label htmlFor="name">{tOrgs('name')}</Label>
                  <Input id="name" {...register('name')} placeholder={tDialog('namePlaceholder')} />
                  {errors.name && (
                    <p className="text-xs text-destructive">{errors.name.message}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="slug">{tOrgs('slug')}</Label>
                  <Input id="slug" {...register('slug')} placeholder={tDialog('slugPlaceholder')} />
                  {errors.slug && (
                    <p className="text-xs text-destructive">{errors.slug.message}</p>
                  )}
                </div>
                {depts && depts.length > 0 && (
                  <div className="space-y-1.5">
                    <Label htmlFor="departmentId">{tDialog('departmentOptional')}</Label>
                    <select
                      id="departmentId"
                      {...register('departmentId')}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      <option value="">{tDialog('noneOption')}</option>
                      {depts.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                    {tCommon('cancel')}
                  </Button>
                  <Button type="submit" disabled={create.isPending}>
                    {create.isPending ? tCommon('creating') : tCommon('create')}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {isLoading ? (
        <Card className="shadow-card p-6 text-sm text-muted-foreground">{tCommon('loading')}</Card>
      ) : !teams || teams.length === 0 ? (
        <Card className="shadow-card flex flex-col items-center p-10 text-center">
          <Users className="h-6 w-6 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-semibold">{t('empty')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('emptyHint')}</p>
        </Card>
      ) : (
        <Card className="shadow-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                <th className="px-4 py-2 text-left font-medium">{t('name')}</th>
                <th className="px-4 py-2 text-left font-medium">{tOrgs('slug')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('department')}</th>
                <th className="px-4 py-2 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => {
                const dept = depts?.find((d) => d.id === team.departmentId)
                return (
                  <tr key={team.id} className="border-b border-border last:border-0 hover:bg-accent/20">
                    <td className="px-4 py-2 font-medium">{team.name}</td>
                    <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{team.slug}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {dept?.name ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        href={`/dashboard/teams/${team.id}`}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        {tDialog('open')}
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
