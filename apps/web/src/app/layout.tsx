import type { ReactNode } from 'react'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'
import { Providers } from './providers'
import { ThemeProvider } from '@/components/theme-provider'

export const metadata = {
  title: 'aide',
  description: 'AI Development Performance Evaluator'
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased font-sans">
        <ThemeProvider>
          <Providers>{children}</Providers>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
