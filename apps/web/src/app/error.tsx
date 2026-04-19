'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="text-center space-y-4 max-w-md">
        <p className="text-sm font-medium text-destructive">發生錯誤</p>
        <h1 className="text-3xl font-semibold tracking-tight">出了點問題</h1>
        <p className="text-muted-foreground">
          {error.message || '系統遇到未預期的錯誤，請稍後再試。'}
        </p>
        {error.digest && (
          <p className="text-xs text-muted-foreground">錯誤代碼: {error.digest}</p>
        )}
        <div className="flex justify-center gap-2 pt-2">
          <Button onClick={reset}>重試</Button>
          <Button variant="outline" asChild>
            <a href="/dashboard">回到首頁</a>
          </Button>
        </div>
      </div>
    </main>
  )
}
