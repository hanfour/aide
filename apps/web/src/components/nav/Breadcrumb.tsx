'use client'
import { usePathname } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import Link from 'next/link'

export function Breadcrumb() {
  const pathname = usePathname() ?? ''
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length <= 1) return <div className="text-sm font-medium">Dashboard</div>

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
      {parts.map((p, i) => {
        const href = '/' + parts.slice(0, i + 1).join('/')
        const isLast = i === parts.length - 1
        const label = decodeURIComponent(p).replace(/-/g, ' ')
        return (
          <div key={href} className="flex items-center gap-1.5">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
            {isLast ? (
              <span className="font-medium capitalize">{label}</span>
            ) : (
              <Link
                href={href}
                className="text-muted-foreground capitalize hover:text-foreground transition-colors"
              >
                {label}
              </Link>
            )}
          </div>
        )
      })}
    </nav>
  )
}
