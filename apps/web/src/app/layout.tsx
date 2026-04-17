import type { ReactNode } from 'react'

export const metadata = {
  title: 'aide',
  description: 'AI Development Performance Evaluator'
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
