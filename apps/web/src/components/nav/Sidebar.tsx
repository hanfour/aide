'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Building2,
  Users,
  UserPlus,
  FileText,
  UserCircle
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { trpc } from '@/lib/trpc/client'

interface NavItem {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  visible: (perm: {
    hasOrg: boolean
    hasTeam: boolean
    hasOrgAdmin: boolean
    hasSuperAdmin: boolean
  }) => boolean
}

const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, visible: () => true },
  { href: '/dashboard/organizations', label: 'Organizations', icon: Building2, visible: (p) => p.hasOrg },
  { href: '/dashboard/teams', label: 'Teams', icon: Users, visible: (p) => p.hasTeam },
  { href: '/dashboard/invites', label: 'Invites', icon: UserPlus, visible: (p) => p.hasOrgAdmin },
  { href: '/dashboard/audit', label: 'Audit Log', icon: FileText, visible: (p) => p.hasOrgAdmin },
  { href: '/dashboard/profile', label: 'Profile', icon: UserCircle, visible: () => true }
]

export function Sidebar() {
  const pathname = usePathname()
  const { data: session } = trpc.me.session.useQuery()

  const perm = {
    hasOrg: (session?.coveredOrgs.length ?? 0) > 0,
    hasTeam: (session?.coveredTeams.length ?? 0) > 0,
    hasOrgAdmin:
      session?.assignments.some(
        (a: { role: string }) => a.role === 'org_admin' || a.role === 'super_admin'
      ) ?? false,
    hasSuperAdmin:
      session?.assignments.some((a: { role: string }) => a.role === 'super_admin') ?? false
  }

  return (
    <aside className="w-60 shrink-0 border-r border-border bg-card">
      <div className="flex h-full flex-col">
        <div className="flex h-14 items-center border-b border-border px-4">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm text-primary-foreground">
              a
            </div>
            <span className="text-sm">aide</span>
          </Link>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {NAV_ITEMS.filter((item) => item.visible(perm)).map((item) => {
            const Icon = item.icon
            const active =
              pathname === item.href || pathname?.startsWith(item.href + '/') || false
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            )
          })}
        </nav>
      </div>
    </aside>
  )
}
