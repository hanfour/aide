'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, ShieldAlert } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { RequirePerm } from '@/components/RequirePerm'
import { AccountCreateForm } from '@/components/accounts/AccountCreateForm'

export default function NewAccountPage() {
  const params = useParams()
  const orgId = params?.id as string

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link
        href={`/dashboard/organizations/${orgId}/accounts`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to accounts
      </Link>

      <RequirePerm
        action={{ type: 'account.create', orgId, teamId: null }}
        fallback={
          <Card className="shadow-card flex flex-col items-center p-10 text-center">
            <ShieldAlert className="h-6 w-6 text-muted-foreground" />
            <h3 className="mt-3 text-sm font-semibold">You can’t create accounts here</h3>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Ask a workspace admin for the <code className="font-mono">account.create</code>{' '}
              permission.
            </p>
          </Card>
        }
      >
        <Card className="shadow-card">
          <CardHeader>
            <CardTitle>New upstream account</CardTitle>
            <CardDescription>
              Add an Anthropic credential that the gateway can use to route requests.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AccountCreateForm orgId={orgId} />
          </CardContent>
        </Card>
      </RequirePerm>
    </div>
  )
}
