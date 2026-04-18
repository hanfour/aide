import { auth, signOut } from '@/auth'
import { redirect } from 'next/navigation'

export default async function DashboardPage() {
  const session = await auth()
  if (!session?.user) redirect('/sign-in')

  async function doSignOut() {
    'use server'
    await signOut({ redirectTo: '/sign-in' })
  }

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Dashboard</h1>
      <p>Signed in as {session.user.email}</p>
      <form action={doSignOut}>
        <button type="submit">Sign out</button>
      </form>
    </main>
  )
}
