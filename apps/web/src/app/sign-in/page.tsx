import { signIn } from '@/auth'

export default function SignInPage() {
  async function signInGoogle() {
    'use server'
    await signIn('google', { redirectTo: '/dashboard' })
  }
  async function signInGitHub() {
    'use server'
    await signIn('github', { redirectTo: '/dashboard' })
  }

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Sign in to aide</h1>
      <form action={signInGoogle}>
        <button type="submit">Sign in with Google</button>
      </form>
      <form action={signInGitHub} style={{ marginTop: 12 }}>
        <button type="submit">Sign in with GitHub</button>
      </form>
    </main>
  )
}
