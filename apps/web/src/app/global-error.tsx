'use client'

import { useEffect } from 'react'

export default function GlobalError({
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
    <html lang="zh-Hant">
      <body
        style={{
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif',
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#fff',
          color: '#000',
        }}
      >
        <div style={{ textAlign: 'center', padding: 24, maxWidth: 420 }}>
          <p style={{ fontSize: 14, fontWeight: 600, color: '#ff3b30', marginBottom: 8 }}>
            系統錯誤
          </p>
          <h1 style={{ fontSize: 28, fontWeight: 600, margin: '0 0 12px' }}>
            應用程式無法載入
          </h1>
          <p style={{ color: '#6e6e73', marginBottom: 20 }}>
            {error.message || '發生未預期的錯誤，請重新整理頁面。'}
          </p>
          {error.digest && (
            <p style={{ fontSize: 12, color: '#8e8e93', marginBottom: 16 }}>
              錯誤代碼: {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            style={{
              padding: '10px 20px',
              background: '#007aff',
              color: '#fff',
              border: 'none',
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            重試
          </button>
        </div>
      </body>
    </html>
  )
}
