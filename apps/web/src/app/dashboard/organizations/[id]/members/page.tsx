'use client'

import { useParams } from 'next/navigation'
import { Users } from 'lucide-react'
import { trpc } from '@/lib/trpc/client'
import { Card } from '@/components/ui/card'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'

export default function MembersTab() {
  const params = useParams()
  const orgId = params?.id as string
  const { data: members, isLoading } = trpc.users.list.useQuery({ orgId })

  if (isLoading) {
    return <Card className="shadow-card p-6 text-sm text-muted-foreground">Loading…</Card>
  }

  if (!members || members.length === 0) {
    return (
      <Card className="shadow-card flex flex-col items-center p-10 text-center">
        <Users className="h-6 w-6 text-muted-foreground" />
        <h3 className="mt-3 text-sm font-semibold">No members yet</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Invite teammates from the Invites tab.
        </p>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {members.length} {members.length === 1 ? 'member' : 'members'}
      </p>
      <Card className="shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
              <th className="px-4 py-2 text-left font-medium">Member</th>
              <th className="px-4 py-2 text-left font-medium">Joined</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr
                key={m.id}
                className="border-b border-border last:border-0 hover:bg-accent/20"
              >
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="bg-primary/10 text-xs text-primary">
                        {m.email.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="font-medium">{m.name ?? m.email}</div>
                      <div className="text-xs text-muted-foreground">{m.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">
                  {new Date(m.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
