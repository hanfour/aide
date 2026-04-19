'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  const isForbidden = /forbidden|unauthorized|permission/i.test(error.message)

  return (
    <div className="min-h-[400px] flex items-center justify-center p-6">
      <div className="text-center space-y-3 max-w-md">
        <p className="text-sm font-medium text-destructive">
          {isForbidden ? '權限不足' : '載入失敗'}
        </p>
        <h2 className="text-2xl font-semibold tracking-tight">
          {isForbidden ? '您沒有權限存取此資源' : '無法載入此頁面'}
        </h2>
        <p className="text-muted-foreground text-sm">
          {error.message || '請稍後再試或聯絡管理員。'}
        </p>
        <div className="flex justify-center gap-2 pt-2">
          {!isForbidden && <Button onClick={reset}>重試</Button>}
          <Button variant="outline" asChild>
            <a href="/dashboard">回到首頁</a>
          </Button>
        </div>
      </div>
    </div>
  )
}
