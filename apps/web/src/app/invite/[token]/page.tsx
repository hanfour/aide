'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Mail, CheckCircle2, XCircle } from 'lucide-react'
import { trpc } from '@/lib/trpc/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default function AcceptInvitePage() {
  const params = useParams()
  const router = useRouter()
  const token = params?.token as string
  const [state, setState] = useState<'idle' | 'accepting' | 'accepted' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string>('')

  const { data: session, isLoading: sessionLoading } = trpc.me.session.useQuery()
  const accept = trpc.invites.accept.useMutation({
    onSuccess: (res) => {
      setState('accepted')
      setTimeout(() => router.push(`/dashboard/organizations/${res.orgId}`), 1000)
    },
    onError: (e) => {
      setState('error')
      const code = (e.data as { code?: string } | undefined)?.code
      if (code === 'FORBIDDEN') setErrorMsg('This invite was issued to a different email.')
      else if (code === 'NOT_FOUND') setErrorMsg('This invite is invalid or has expired.')
      else setErrorMsg(e.message)
    }
  })

  useEffect(() => {
    if (sessionLoading) return
    if (!session?.user) {
      const returnTo = encodeURIComponent(`/invite/${token}`)
      router.push(`/sign-in?returnTo=${returnTo}`)
      return
    }
    if (state === 'idle') {
      setState('accepting')
      accept.mutateAsync({ token })
    }
  }, [sessionLoading, session, state, token, router, accept])

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md shadow-card">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            {state === 'accepted' ? (
              <CheckCircle2 className="h-6 w-6 text-primary" />
            ) : state === 'error' ? (
              <XCircle className="h-6 w-6 text-destructive" />
            ) : (
              <Mail className="h-6 w-6 text-primary" />
            )}
          </div>
          <CardTitle>
            {state === 'accepted'
              ? 'Invite accepted'
              : state === 'error'
              ? 'Unable to accept invite'
              : 'Accepting invite…'}
          </CardTitle>
          <CardDescription>
            {state === 'accepted'
              ? 'Redirecting you to the workspace.'
              : state === 'error'
              ? errorMsg
              : 'Please wait a moment.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state === 'error' && (
            <div className="flex justify-center">
              <Button onClick={() => router.push('/dashboard')}>Go to dashboard</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
