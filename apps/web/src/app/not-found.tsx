import Link from 'next/link'
import { Button } from '@/components/ui/button'

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="text-center space-y-4 max-w-md">
        <p className="text-sm font-medium text-primary">404</p>
        <h1 className="text-3xl font-semibold tracking-tight">找不到頁面</h1>
        <p className="text-muted-foreground">
          您要前往的頁面不存在或已被移除。
        </p>
        <Button asChild>
          <Link href="/dashboard">回到首頁</Link>
        </Button>
      </div>
    </main>
  )
}
