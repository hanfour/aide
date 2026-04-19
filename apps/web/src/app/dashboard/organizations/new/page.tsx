'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { trpc } from '@/lib/trpc/client'

const schema = z.object({
  slug: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/, 'lowercase letters, numbers, dashes'),
  name: z.string().min(1).max(255)
})

type FormValues = z.infer<typeof schema>

export default function NewOrganizationPage() {
  const router = useRouter()
  const create = trpc.organizations.create.useMutation({
    onSuccess: (org) => {
      toast.success(`Organization "${org?.name}" created`)
      router.push(`/dashboard/organizations/${org?.id}`)
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code
      if (code === 'FORBIDDEN') {
        toast.error('Only platform admins can create organizations.')
      } else {
        toast.error(e.message)
      }
    }
  })

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(schema)
  })

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <Link
        href="/dashboard/organizations"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to organizations
      </Link>

      <Card className="shadow-card">
        <CardHeader>
          <CardTitle>New organization</CardTitle>
          <CardDescription>
            Create a workspace where teams, departments, and members live.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleSubmit((v) => create.mutateAsync(v))}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label htmlFor="name">Display name</Label>
              <Input id="name" placeholder="Acme Corp" {...register('name')} />
              {errors.name && (
                <p className="text-xs text-destructive">{errors.name.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="slug">URL slug</Label>
              <Input id="slug" placeholder="acme" {...register('slug')} />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers, and dashes. Used in URLs.
              </p>
              {errors.slug && (
                <p className="text-xs text-destructive">{errors.slug.message}</p>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" asChild>
                <Link href="/dashboard/organizations">Cancel</Link>
              </Button>
              <Button type="submit" disabled={isSubmitting || create.isPending}>
                {create.isPending ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
