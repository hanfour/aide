'use client'
import { Search } from 'lucide-react'

export function SearchCommand() {
  return (
    <button
      className="inline-flex h-8 w-64 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 text-xs text-muted-foreground hover:bg-muted/60 transition-colors"
      aria-label="Search"
    >
      <Search className="h-3.5 w-3.5" />
      <span className="flex-1 text-left">Search…</span>
      <kbd className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-sans">
        ⌘K
      </kbd>
    </button>
  )
}
