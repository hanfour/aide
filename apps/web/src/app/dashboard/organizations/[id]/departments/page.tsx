'use client'

import { useState } from 'react'
import { useParams } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Plus, Network } from 'lucide-react'
import { toast } from 'sonner'
import { trpc } from '@/lib/trpc/client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/, 'lowercase letters, numbers, dashes'),
  name: z.string().min(1).max(255)
})

export default function DepartmentsTab() {
  const params = useParams()
  const orgId = params?.id as string
  const [open, setOpen] = useState(false)
  const utils = trpc.useUtils()
  const { data: depts, isLoading } = trpc.departments.list.useQuery({ orgId })
  const { data: session } = trpc.me.session.useQuery()

  const canCreate =
    session?.assignments.some(
      (a: { role: string; scopeType: string; scopeId: string | null }) =>
        (a.role === 'org_admin' && a.scopeId === orgId) || a.role === 'super_admin'
    ) ?? false

  const create = trpc.departments.create.useMutation({
    onSuccess: (dept) => {
      toast.success(`Department "${dept?.name}" created`)
      setOpen(false)
      reset()
      utils.departments.list.invalidate({ orgId })
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code
      toast.error(code === 'FORBIDDEN' ? 'Insufficient permission' : e.message)
    }
  })

  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema)
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Departments group teams within this workspace.
        </p>
        {canCreate && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1.5">
                <Plus className="h-4 w-4" />
                New department
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New department</DialogTitle>
                <DialogDescription>
                  Group related teams under one department.
                </DialogDescription>
              </DialogHeader>
              <form
                onSubmit={handleSubmit((v) => create.mutateAsync({ ...v, orgId }))}
                className="space-y-4"
              >
                <div className="space-y-1.5">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" {...register('name')} placeholder="Engineering" />
                  {errors.name && (
                    <p className="text-xs text-destructive">{errors.name.message}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="slug">Slug</Label>
                  <Input id="slug" {...register('slug')} placeholder="engineering" />
                  {errors.slug && (
                    <p className="text-xs text-destructive">{errors.slug.message}</p>
                  )}
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={create.isPending}>
                    {create.isPending ? 'Creating…' : 'Create'}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {isLoading ? (
        <Card className="shadow-card p-6 text-sm text-muted-foreground">Loading…</Card>
      ) : !depts || depts.length === 0 ? (
        <Card className="shadow-card flex flex-col items-center p-10 text-center">
          <Network className="h-6 w-6 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-semibold">No departments yet</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Create one to start grouping teams.
          </p>
        </Card>
      ) : (
        <Card className="shadow-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-left font-medium">Slug</th>
                <th className="px-4 py-2 text-left font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {depts.map((d) => (
                <tr key={d.id} className="border-b border-border last:border-0 hover:bg-accent/20">
                  <td className="px-4 py-2 font-medium">{d.name}</td>
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{d.slug}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {new Date(d.createdAt).toLocaleDateString()}
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
