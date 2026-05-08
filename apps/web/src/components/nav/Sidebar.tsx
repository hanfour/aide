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

interface Perm {
  hasOrg: boolean
  hasTeam: boolean
  hasOrgAdmin: boolean
  hasSuperAdmin: boolean
}

interface SessionLike {
  coveredOrgs: string[]
}

interface NavItem {
  href: string | ((p: Perm, session: SessionLike | undefined) => string | null)
  label: string
  icon: React.ComponentType<{ className?: string }>
  visible: (p: Perm) => boolean
}

interface NavSection {
  title: string
  items: NavItem[]
}

// `/dashboard/invites` and `/dashboard/audit` don't exist as top-level
// pages — only the org-scoped variants under
// `/dashboard/organizations/[id]/{invites,audit}` are wired. Until a
// multi-org top-level view is built, link directly to the first covered
// org so the sidebar entry actually leads somewhere instead of 404.
function firstOrgHref(suffix: string) {
  return (_p: Perm, session: SessionLike | undefined): string | null => {
    const orgId = session?.coveredOrgs[0]
    return orgId ? `/dashboard/organizations/${orgId}/${suffix}` : null
  }
}

const SECTIONS: NavSection[] = [
  {
    title: 'Overview',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, visible: () => true }
    ]
  },
  {
    title: 'Workspace',
    items: [
      { href: '/dashboard/organizations', label: 'Organizations', icon: Building2, visible: (p) => p.hasOrg },
      { href: '/dashboard/teams', label: 'Teams', icon: Users, visible: (p) => p.hasTeam },
      { href: firstOrgHref('invites'), label: 'Invites', icon: UserPlus, visible: (p) => p.hasOrgAdmin },
      { href: firstOrgHref('audit'), label: 'Audit Log', icon: FileText, visible: (p) => p.hasOrgAdmin }
    ]
  },
  {
    title: 'Account',
    items: [
      { href: '/dashboard/profile', label: 'Profile', icon: UserCircle, visible: () => true }
    ]
  }
]

export function Sidebar() {
  const pathname = usePathname()
  const { data: session } = trpc.me.session.useQuery()

  const perm: Perm = {
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
    <aside className="w-60 shrink-0 border-r border-border bg-card/40">
      <div className="flex h-full flex-col">
        <div className="flex h-14 items-center border-b border-border px-5">
          <Link href="/dashboard" className="flex items-center gap-2.5 font-semibold">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-sm text-primary-foreground shadow-card">
              a
            </div>
            <span className="text-[15px] tracking-tight">aide</span>
          </Link>
        </div>
        <nav className="flex-1 overflow-y-auto p-3">
          {SECTIONS.map((section) => {
            // Resolve dynamic hrefs first; items returning `null` are
            // hidden (e.g. Invites/Audit when the user has no covered
            // org yet — the link target wouldn't exist).
            const resolved = section.items
              .filter((i) => i.visible(perm))
              .map((i) => {
                const href = typeof i.href === 'function' ? i.href(perm, session) : i.href
                return href ? { ...i, href } : null
              })
              .filter((x): x is NavItem & { href: string } => x !== null)
            if (resolved.length === 0) return null
            return (
              <div key={section.title} className="mb-4">
                <div className="mb-1.5 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {section.title}
                </div>
                <div className="space-y-0.5">
                  {resolved.map((item) => {
                    const Icon = item.icon
                    const active =
                      pathname === item.href ||
                      (item.href !== '/dashboard' && pathname?.startsWith(item.href + '/')) ||
                      false
                    return (
                      <Link
                        key={item.label}
                        href={item.href}
                        className={cn(
                          'flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm transition-colors',
                          active
                            ? 'bg-accent text-accent-foreground font-medium'
                            : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'
                        )}
                      >
                        <Icon className="h-4 w-4" />
                        {item.label}
                      </Link>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </nav>
      </div>
    </aside>
  )
}
