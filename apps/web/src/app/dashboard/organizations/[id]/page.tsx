'use client'

import { useParams } from 'next/navigation'
import { Calendar, Hash } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { trpc } from '@/lib/trpc/client'

export default function OrganizationOverviewPage() {
  const params = useParams()
  const orgId = params?.id as string
  const { data: org, isLoading } = trpc.organizations.get.useQuery({ id: orgId })

  if (isLoading) return <Card className="shadow-card p-6 text-sm text-muted-foreground">Loading…</Card>
  if (!org) return <Card className="shadow-card p-6 text-sm text-muted-foreground">Not found.</Card>

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card className="shadow-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <Hash className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Slug</span>
            <span className="ml-auto font-mono text-xs">{org.slug}</span>
          </div>
          <div className="flex items-center gap-2">
            <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Created</span>
            <span className="ml-auto text-xs">
              {new Date(org.createdAt).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
              })}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Quick links
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Use the tabs above to manage departments, teams, members, invites, and audit logs.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
