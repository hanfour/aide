'use client'

import Link from 'next/link'
import { Building2, Network, Users, Plus, Mail, FileText, ArrowRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { trpc } from '@/lib/trpc/client'

export default function DashboardPage() {
  const { data: session, isLoading } = trpc.me.session.useQuery()

  if (isLoading) return <div className="text-muted-foreground">Loading…</div>
  if (!session) return null

  const stats = [
    { label: 'Organizations', value: session.coveredOrgs.length, icon: Building2 },
    { label: 'Departments', value: session.coveredDepts.length, icon: Network },
    { label: 'Teams', value: session.coveredTeams.length, icon: Users }
  ]

  const isAdmin = session.assignments.some(
    (a: { role: string }) =>
      a.role === 'org_admin' || a.role === 'super_admin' || a.role === 'dept_manager'
  )

  const quickActions = [
    {
      href: '/dashboard/organizations/new',
      label: 'Create organization',
      desc: 'Spin up a new workspace',
      icon: Plus,
      visible: session.assignments.some((a: { role: string }) => a.role === 'super_admin')
    },
    {
      href: '/dashboard/invites',
      label: 'Invite someone',
      desc: 'Send an invite to a new member',
      icon: Mail,
      visible: isAdmin
    },
    {
      href: '/dashboard/audit',
      label: 'Review audit log',
      desc: 'See recent activity',
      icon: FileText,
      visible: isAdmin
    }
  ].filter((a) => a.visible)

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-[28px] font-semibold tracking-tight">
          Welcome back, {session.user?.email?.split('@')[0]}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Here&apos;s what&apos;s happening in your workspace.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((s) => {
          const Icon = s.icon
          return (
            <Card key={s.label} className="shadow-card">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {s.label}
                </CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-semibold tracking-tight">{s.value}</div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {quickActions.length > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">Quick actions</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            {quickActions.map((a) => {
              const Icon = a.icon
              return (
                <Link
                  key={a.href}
                  href={a.href}
                  className="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-card hover:bg-accent/20 hover:shadow-card-lg transition-all"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{a.label}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{a.desc}</p>
                  </div>
                </Link>
              )
            })}
          </div>
        </section>
      )}

      <Card className="shadow-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Your roles</CardTitle>
        </CardHeader>
        <CardContent>
          {session.assignments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active roles.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {session.assignments.map(
                (a: { id: string; role: string; scopeType: string; scopeId: string | null }) => (
                  <Badge key={a.id} variant="secondary" className="rounded-md font-normal">
                    {a.role}
                    <span className="mx-1 text-muted-foreground">@</span>
                    <span className="text-muted-foreground">{a.scopeType}</span>
                  </Badge>
                )
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
