'use client'

import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { trpc } from '@/lib/trpc/client'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const STATIC_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  organizations: 'Organizations',
  teams: 'Teams',
  departments: 'Departments',
  invites: 'Invites',
  audit: 'Audit',
  members: 'Members',
  profile: 'Profile',
  settings: 'Settings',
  new: 'New'
}

interface Crumb {
  href: string
  label: string
}

export function Breadcrumb() {
  const pathname = usePathname() ?? ''
  const parts = pathname.split('/').filter(Boolean)

  // Extract UUIDs that need name lookups and their context (previous segment)
  let orgId: string | undefined
  let teamId: string | undefined
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    const prev = parts[i - 1]
    if (UUID_RE.test(p)) {
      if (prev === 'organizations') orgId = p
      else if (prev === 'teams') teamId = p
    }
  }

  const org = trpc.organizations.get.useQuery({ id: orgId! }, { enabled: !!orgId })
  const team = trpc.teams.get.useQuery({ id: teamId! }, { enabled: !!teamId })

  const crumbs: Crumb[] = parts.map((p, i) => {
    const href = '/' + parts.slice(0, i + 1).join('/')
    let label: string
    if (UUID_RE.test(p)) {
      if (p === orgId) label = org.data?.name ?? '…'
      else if (p === teamId) label = team.data?.name ?? '…'
      else label = '…'
    } else {
      label = STATIC_LABELS[p] ?? p.charAt(0).toUpperCase() + p.slice(1).replace(/-/g, ' ')
    }
    return { href, label }
  })

  // Truncate to 3 visible if too deep
  const MAX = 4
  let visible: Array<Crumb | 'ellipsis'> = crumbs
  if (crumbs.length > MAX) {
    visible = [crumbs[0]!, 'ellipsis', crumbs[crumbs.length - 2]!, crumbs[crumbs.length - 1]!]
  }

  if (crumbs.length === 0) return null
  if (crumbs.length === 1) return <div className="text-sm font-medium">{crumbs[0]!.label}</div>

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
      {visible.map((c, i) => {
        const isLast = i === visible.length - 1
        if (c === 'ellipsis') {
          return (
            <div key={`e-${i}`} className="flex items-center gap-1.5">
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">…</span>
            </div>
          )
        }
        return (
          <div key={c.href} className="flex items-center gap-1.5">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
            {isLast ? (
              <span className="font-medium">{c.label}</span>
            ) : (
              <Link
                href={c.href}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {c.label}
              </Link>
            )}
          </div>
        )
      })}
    </nav>
  )
}
