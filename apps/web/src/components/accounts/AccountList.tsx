'use client'

import { useState } from 'react'
import { MoreHorizontal, Key, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { trpc } from '@/lib/trpc/client'
import { usePermissions } from '@/lib/usePermissions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

interface AccountRow {
  id: string
  orgId: string
  teamId: string | null
  name: string
  platform: string
  type: string
  status: string
  schedulable: boolean
  priority: number
  concurrency: number
  rateLimitedAt: Date | string | null
  rateLimitResetAt: Date | string | null
  overloadUntil: Date | string | null
  tempUnschedulableUntil: Date | string | null
  expiresAt: Date | string | null
  errorMessage: string | null
  lastUsedAt: Date | string | null
}

type AccountStatus =
  | 'disabled'
  | 'rate_limited'
  | 'overloaded'
  | 'paused'
  | 'expired'
  | 'error'
  | 'active'

type StatusTone = 'success' | 'warning' | 'destructive' | 'muted'

// Precedence order matters: the most actionable/terminal state wins. A rate-
// limited account that is also disabled is displayed as `disabled` (operator
// turned it off — that's the truth), and an expired account wins over a
// generic `error` because "expired" is a more specific diagnosis.
// disabled > rate_limited > overloaded > paused > expired > error > active
function deriveAccountStatus(
  row: AccountRow,
  now: Date = new Date()
): AccountStatus {
  if (!row.schedulable) return 'disabled'

  const rateLimitedAt = toDate(row.rateLimitedAt)
  const rateLimitResetAt = toDate(row.rateLimitResetAt)
  if (rateLimitedAt && (!rateLimitResetAt || rateLimitResetAt > now)) {
    return 'rate_limited'
  }

  const overloadUntil = toDate(row.overloadUntil)
  if (overloadUntil && overloadUntil > now) return 'overloaded'

  const pausedUntil = toDate(row.tempUnschedulableUntil)
  if (pausedUntil && pausedUntil > now) return 'paused'

  const expiresAt = toDate(row.expiresAt)
  if (expiresAt && expiresAt <= now) return 'expired'

  if ((row.errorMessage && row.errorMessage.length > 0) || row.status !== 'active') {
    return 'error'
  }

  return 'active'
}

function toDate(v: Date | string | null): Date | null {
  if (!v) return null
  if (v instanceof Date) return v
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

const STATUS_LABEL: Record<AccountStatus, string> = {
  active: 'Active',
  disabled: 'Disabled',
  rate_limited: 'Rate limited',
  overloaded: 'Overloaded',
  paused: 'Paused',
  expired: 'Expired',
  error: 'Error'
}

const STATUS_TONE: Record<AccountStatus, StatusTone> = {
  active: 'success',
  disabled: 'muted',
  rate_limited: 'warning',
  overloaded: 'warning',
  paused: 'warning',
  expired: 'destructive',
  error: 'destructive'
}

// Apple-ish soft tones — solid bg at ~10% opacity with saturated foreground.
// Kept as className overrides on the existing Badge component (variant=outline
// strips its own bg/border) so we don't redesign the shared badge.
const TONE_CLASSNAME: Record<StatusTone, string> = {
  success: 'border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  warning: 'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  destructive: 'border-transparent bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300',
  muted: 'border-transparent bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300'
}

function StatusBadge({ status }: { status: AccountStatus }) {
  return (
    <Badge variant="outline" className={cn('font-medium', TONE_CLASSNAME[STATUS_TONE[status]])}>
      {STATUS_LABEL[status]}
    </Badge>
  )
}

function formatRelative(ts: Date | string | null): string {
  const d = toDate(ts)
  if (!d) return '—'
  const diffMs = d.getTime() - Date.now()
  const absSec = Math.abs(diffMs) / 1000
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 60 * 60 * 24 * 365],
    ['month', 60 * 60 * 24 * 30],
    ['day', 60 * 60 * 24],
    ['hour', 60 * 60],
    ['minute', 60],
    ['second', 1]
  ]
  for (const [unit, secs] of units) {
    if (absSec >= secs || unit === 'second') {
      const value = Math.round(diffMs / 1000 / secs)
      return rtf.format(value, unit)
    }
  }
  return d.toLocaleString()
}

interface AccountRowActionsProps {
  row: AccountRow
  orgId: string
  onDelete: (row: AccountRow) => void
  isDeleting: boolean
}

function AccountRowActions({ row, orgId, onDelete, isDeleting }: AccountRowActionsProps) {
  const { can } = usePermissions()
  const canRotate = can({ type: 'account.rotate', orgId, accountId: row.id })
  const canUpdate = can({ type: 'account.update', orgId, accountId: row.id })
  const canDelete = can({ type: 'account.delete', orgId, accountId: row.id })

  // If the caller has no row-level actions at all, render nothing rather than
  // a dead trigger.
  if (!canRotate && !canUpdate && !canDelete) return null

  const handleRotate = () => {
    toast.info('Rotate flow lands in a follow-up task')
  }

  const handleEdit = () => {
    toast.info('Edit flow lands in a follow-up task')
  }

  const handleDelete = () => {
    if (typeof window === 'undefined') return
    const ok = window.confirm(
      `Remove account "${row.name}"? This marks it as deleted and unschedulable.`
    )
    if (!ok) return
    onDelete(row)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          aria-label={`Actions for ${row.name}`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canRotate && (
          <DropdownMenuItem onSelect={handleRotate}>
            <Key className="h-4 w-4" />
            Rotate credentials
          </DropdownMenuItem>
        )}
        {canUpdate && (
          <DropdownMenuItem onSelect={handleEdit}>Edit</DropdownMenuItem>
        )}
        {canDelete && (
          <>
            {(canRotate || canUpdate) && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onSelect={handleDelete}
              disabled={isDeleting}
              className="text-destructive focus:text-destructive"
            >
              {isDeleting ? 'Deleting…' : 'Delete'}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface AccountListProps {
  orgId: string
}

export function AccountList({ orgId }: AccountListProps) {
  const utils = trpc.useUtils()
  const { data: accounts, isLoading, error } = trpc.accounts.list.useQuery({ orgId })
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const del = trpc.accounts.delete.useMutation({
    onSuccess: () => {
      toast.success('Account removed')
      utils.accounts.list.invalidate({ orgId })
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code
      toast.error(code === 'FORBIDDEN' ? 'Insufficient permission' : e.message)
    },
    onSettled: () => {
      setDeletingId(null)
    }
  })

  const handleDelete = (row: AccountRow) => {
    setDeletingId(row.id)
    del.mutate({ id: row.id })
  }

  if (isLoading) {
    return <Card className="shadow-card p-6 text-sm text-muted-foreground">Loading…</Card>
  }

  if (error) {
    return (
      <Card className="shadow-card flex flex-col items-center p-10 text-center">
        <ShieldAlert className="h-6 w-6 text-muted-foreground" />
        <h3 className="mt-3 text-sm font-semibold">Unable to load accounts</h3>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">{error.message}</p>
      </Card>
    )
  }

  if (!accounts || accounts.length === 0) {
    return (
      <Card className="shadow-card flex flex-col items-center p-10 text-center">
        <Key className="h-6 w-6 text-muted-foreground" />
        <h3 className="mt-3 text-sm font-semibold">No upstream accounts yet</h3>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          Add an Anthropic API key or OAuth credential to start routing requests.
        </p>
      </Card>
    )
  }

  return (
    <Card className="shadow-card overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
            <th className="px-4 py-2 text-left font-medium">Name</th>
            <th className="px-4 py-2 text-left font-medium">Platform</th>
            <th className="px-4 py-2 text-left font-medium">Type</th>
            <th className="px-4 py-2 text-left font-medium">Status</th>
            <th className="px-4 py-2 text-right font-medium">Priority</th>
            <th className="px-4 py-2 text-right font-medium">Concurrency</th>
            <th className="px-4 py-2 text-left font-medium">Last used</th>
            <th className="px-4 py-2 text-right font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((row) => {
            const typed = row as unknown as AccountRow
            const status = deriveAccountStatus(typed)
            const lastUsedTitle = typed.lastUsedAt
              ? new Date(typed.lastUsedAt).toLocaleString()
              : undefined
            return (
              <tr
                key={typed.id}
                className="border-b border-border last:border-0 hover:bg-accent/20"
              >
                <td className="px-4 py-2.5 font-medium">{typed.name}</td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">{typed.platform}</td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">
                  {typed.type === 'oauth' ? 'OAuth' : 'API key'}
                </td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={status} />
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{typed.priority}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{typed.concurrency}</td>
                <td
                  className="px-4 py-2.5 text-xs text-muted-foreground"
                  title={lastUsedTitle}
                >
                  {formatRelative(typed.lastUsedAt)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <AccountRowActions
                    row={typed}
                    orgId={orgId}
                    onDelete={handleDelete}
                    isDeleting={deletingId === typed.id}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}

export { deriveAccountStatus }
