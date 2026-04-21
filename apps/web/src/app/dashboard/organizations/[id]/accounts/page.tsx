'use client'

import { useParams } from 'next/navigation'
import { ShieldAlert } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { RequirePerm } from '@/components/RequirePerm'
import { AccountList } from '@/components/accounts/AccountList'

export default function AccountsTab() {
  const params = useParams()
  const orgId = params?.id as string

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold tracking-tight">Upstream accounts</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Anthropic credentials used to route requests for this workspace.
        </p>
      </div>

      <RequirePerm
        action={{ type: 'account.read', orgId }}
        fallback={
          <Card className="shadow-card flex flex-col items-center p-10 text-center">
            <ShieldAlert className="h-6 w-6 text-muted-foreground" />
            <h3 className="mt-3 text-sm font-semibold">You can’t view accounts here</h3>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Ask a workspace admin for the <code className="font-mono">account.read</code>{' '}
              permission.
            </p>
          </Card>
        }
      >
        <AccountList orgId={orgId} />
      </RequirePerm>
    </div>
  )
}
