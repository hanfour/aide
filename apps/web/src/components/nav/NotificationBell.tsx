'use client'
import { Bell } from 'lucide-react'

export function NotificationBell() {
  return (
    <button
      aria-label="Notifications"
      className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
    >
      <Bell className="h-4 w-4" />
    </button>
  )
}
