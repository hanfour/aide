'use client'

import Link from 'next/link'
import { Building2, Plus, ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { trpc } from '@/lib/trpc/client'

export default function OrganizationsListPage() {
  const { data: orgs, isLoading } = trpc.organizations.list.useQuery()
  const { data: session } = trpc.me.session.useQuery()
  const isSuperAdmin =
    session?.assignments.some((a: { role: string }) => a.role === 'super_admin') ?? false

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Organizations</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Workspaces you can access.
          </p>
        </div>
        {isSuperAdmin && (
          <Button asChild size="sm" className="gap-1.5">
            <Link href="/dashboard/organizations/new">
              <Plus className="h-4 w-4" />
              New organization
            </Link>
          </Button>
        )}
      </div>

      {isLoading ? (
        <Card className="shadow-card p-8 text-sm text-muted-foreground">Loading…</Card>
      ) : !orgs || orgs.length === 0 ? (
        <Card className="shadow-card flex flex-col items-center justify-center p-12 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent">
            <Building2 className="h-6 w-6 text-accent-foreground" />
          </div>
          <h3 className="text-base font-semibold">No organizations yet</h3>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            {isSuperAdmin
              ? 'Create the first organization to get started.'
              : 'Ask an administrator to invite you.'}
          </p>
          {isSuperAdmin && (
            <Button asChild className="mt-4 gap-1.5" size="sm">
              <Link href="/dashboard/organizations/new">
                <Plus className="h-4 w-4" />
                New organization
              </Link>
            </Button>
          )}
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {orgs.map((org) => (
            <Link
              key={org.id}
              href={`/dashboard/organizations/${org.id}`}
              className="group rounded-xl border border-border bg-card p-5 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-card-lg"
            >
              <div className="flex items-start justify-between">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary font-semibold">
                  {org.name.charAt(0).toUpperCase()}
                </div>
                <ArrowUpRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
              <h3 className="mt-4 text-sm font-semibold">{org.name}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">/{org.slug}</p>
              <div className="mt-3 flex items-center gap-2">
                <Badge variant="secondary" className="rounded-md text-[10px] font-normal">
                  Active
                </Badge>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
