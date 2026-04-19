'use client'

import { Building2, Network, Users } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { trpc } from '@/lib/trpc/client'

export default function DashboardPage() {
  const { data: session, isLoading } = trpc.me.session.useQuery()

  if (isLoading) {
    return <div className="text-muted-foreground">Loading...</div>
  }
  if (!session) return null

  const stats = [
    { label: 'Organizations', value: session.coveredOrgs.length, icon: Building2 },
    { label: 'Departments', value: session.coveredDepts.length, icon: Network },
    { label: 'Teams', value: session.coveredTeams.length, icon: Users }
  ]

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">
          Welcome, {session.user?.email}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Overview of your access and assignments.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((s) => {
          const Icon = s.icon
          return (
            <Card key={s.label}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {s.label}
                </CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold">{s.value}</div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Your roles</CardTitle>
        </CardHeader>
        <CardContent>
          {session.assignments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active roles.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {session.assignments.map((a) => (
                <Badge key={a.id} variant="secondary">
                  {a.role} @ {a.scopeType}
                  {a.scopeId ? `:${a.scopeId.slice(0, 8)}` : ''}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
