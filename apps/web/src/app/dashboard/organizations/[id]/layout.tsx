'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useParams } from 'next/navigation'
import { cn } from '@/lib/utils'
import { trpc } from '@/lib/trpc/client'

interface Tab {
  href: string
  label: string
  visible: (p: { isSuperAdmin: boolean; isOrgAdmin: boolean; hasDeptOrTeamMgr: boolean }) => boolean
}

export default function OrganizationLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? ''
  const params = useParams()
  const orgId = params?.id as string
  const { data: org } = trpc.organizations.get.useQuery({ id: orgId })
  const { data: session } = trpc.me.session.useQuery()

  const isSuperAdmin =
    session?.assignments.some((a: { role: string }) => a.role === 'super_admin') ?? false
  const isOrgAdmin =
    session?.assignments.some(
      (a: { role: string; scopeType: string; scopeId: string | null }) =>
        a.role === 'org_admin' && a.scopeType === 'organization' && a.scopeId === orgId
    ) ?? false
  const hasDeptOrTeamMgr =
    session?.assignments.some(
      (a: { role: string }) => a.role === 'dept_manager' || a.role === 'team_manager'
    ) ?? false

  const tabs: Tab[] = [
    { href: '', label: 'Overview', visible: () => true },
    { href: '/departments', label: 'Departments', visible: () => true },
    { href: '/teams', label: 'Teams', visible: () => true },
    {
      href: '/members',
      label: 'Members',
      visible: (p) => p.isSuperAdmin || p.isOrgAdmin || p.hasDeptOrTeamMgr
    },
    {
      href: '/invites',
      label: 'Invites',
      visible: (p) => p.isSuperAdmin || p.isOrgAdmin
    },
    {
      href: '/audit',
      label: 'Audit',
      visible: (p) => p.isSuperAdmin || p.isOrgAdmin
    }
  ]

  const perm = { isSuperAdmin, isOrgAdmin, hasDeptOrTeamMgr }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary font-semibold">
            {org?.name.charAt(0).toUpperCase() ?? '…'}
          </div>
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">
              {org?.name ?? 'Organization'}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">/{org?.slug ?? '…'}</p>
          </div>
        </div>
      </div>

      <div className="border-b border-border">
        <nav className="flex gap-1 overflow-x-auto">
          {tabs.filter((t) => t.visible(perm)).map((t) => {
            const href = `/dashboard/organizations/${orgId}${t.href}`
            const active =
              pathname === href ||
              (t.href === '' && pathname === `/dashboard/organizations/${orgId}`)
            return (
              <Link
                key={t.label}
                href={href}
                className={cn(
                  'relative -mb-px border-b-2 px-3 py-2 text-sm transition-colors',
                  active
                    ? 'border-primary text-foreground font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                {t.label}
              </Link>
            )
          })}
        </nav>
      </div>

      <div>{children}</div>
    </div>
  )
}
