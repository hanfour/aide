'use client'

import { useState } from 'react'
import { useParams } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Plus, Mail, Copy, Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { trpc } from '@/lib/trpc/client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'

const schema = z.object({
  email: z.string().email(),
  role: z.enum(['org_admin', 'dept_manager', 'team_manager', 'member']),
  scopeType: z.enum(['organization', 'department', 'team']),
  scopeId: z.string().uuid().nullable()
})

type FormValues = z.infer<typeof schema>

export default function InvitesTab() {
  const params = useParams()
  const orgId = params?.id as string
  const [open, setOpen] = useState(false)
  const [justCreated, setJustCreated] = useState<{ token: string; email: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const utils = trpc.useUtils()

  const { data: invites, isLoading } = trpc.invites.list.useQuery({ orgId })

  const create = trpc.invites.create.useMutation({
    onSuccess: (inv) => {
      if (inv) {
        setJustCreated({ token: inv.token, email: inv.email })
        utils.invites.list.invalidate({ orgId })
        reset()
      }
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code
      toast.error(code === 'FORBIDDEN' ? 'Insufficient permission' : e.message)
    }
  })

  const revoke = trpc.invites.revoke.useMutation({
    onSuccess: () => {
      toast.success('Invite revoked')
      utils.invites.list.invalidate({ orgId })
    },
    onError: (e) => toast.error(e.message)
  })

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors }
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { role: 'member', scopeType: 'organization', scopeId: orgId }
  })

  const inviteUrl = justCreated
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/invite/${justCreated.token}`
    : ''

  async function copy() {
    if (!inviteUrl) return
    await navigator.clipboard.writeText(inviteUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function closeDialog() {
    setOpen(false)
    setJustCreated(null)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Pending invites for this organization.
        </p>
        <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : closeDialog())}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1.5">
              <Plus className="h-4 w-4" />
              New invite
            </Button>
          </DialogTrigger>
          <DialogContent>
            {!justCreated ? (
              <>
                <DialogHeader>
                  <DialogTitle>New invite</DialogTitle>
                  <DialogDescription>
                    Send this link to invite a user into this workspace.
                  </DialogDescription>
                </DialogHeader>
                <form
                  onSubmit={handleSubmit((v) =>
                    create.mutateAsync({
                      orgId,
                      email: v.email,
                      role: v.role,
                      scopeType: v.scopeType,
                      scopeId: v.scopeType === 'organization' ? orgId : v.scopeId
                    })
                  )}
                  className="space-y-4"
                >
                  <div className="space-y-1.5">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      {...register('email')}
                      placeholder="user@example.com"
                    />
                    {errors.email && (
                      <p className="text-xs text-destructive">{errors.email.message}</p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="role">Role</Label>
                    <select
                      id="role"
                      {...register('role')}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      <option value="member">Member</option>
                      <option value="team_manager">Team Manager</option>
                      <option value="dept_manager">Department Manager</option>
                      <option value="org_admin">Org Admin</option>
                    </select>
                  </div>
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={closeDialog}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={create.isPending}>
                      {create.isPending ? 'Creating…' : 'Create invite'}
                    </Button>
                  </DialogFooter>
                </form>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>Invite created</DialogTitle>
                  <DialogDescription>
                    Share this link with {justCreated.email}. Link expires in 7 days.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <Input value={inviteUrl} readOnly className="font-mono text-xs" />
                    <Button onClick={copy} variant="outline" className="shrink-0 gap-1.5">
                      {copied ? (
                        <>
                          <Check className="h-3.5 w-3.5" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" /> Copy
                        </>
                      )}
                    </Button>
                  </div>
                  <a
                    href={inviteUrl}
                    className="block break-all font-mono text-xs text-primary hover:underline"
                  >
                    {inviteUrl}
                  </a>
                  <p className="text-xs text-muted-foreground">
                    Email delivery is not wired yet — copy the link and send it manually.
                  </p>
                </div>
                <DialogFooter>
                  <Button onClick={closeDialog}>Done</Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <Card className="shadow-card p-6 text-sm text-muted-foreground">Loading…</Card>
      ) : !invites || invites.length === 0 ? (
        <Card className="shadow-card flex flex-col items-center p-10 text-center">
          <Mail className="h-6 w-6 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-semibold">No pending invites</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Invite someone to start collaborating.
          </p>
        </Card>
      ) : (
        <Card className="shadow-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                <th className="px-4 py-2 text-left font-medium">Email</th>
                <th className="px-4 py-2 text-left font-medium">Role</th>
                <th className="px-4 py-2 text-left font-medium">Expires</th>
                <th className="px-4 py-2 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {invites.map((inv) => (
                <tr
                  key={inv.id}
                  className="border-b border-border last:border-0 hover:bg-accent/20"
                >
                  <td className="px-4 py-2 font-medium">{inv.email}</td>
                  <td className="px-4 py-2">
                    <Badge variant="secondary" className="rounded-md text-[10px] font-normal">
                      {inv.role}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {new Date(inv.expiresAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => revoke.mutate({ id: inv.id })}
                      className="gap-1 text-destructive hover:bg-destructive/10"
                    >
                      <X className="h-3.5 w-3.5" />
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
