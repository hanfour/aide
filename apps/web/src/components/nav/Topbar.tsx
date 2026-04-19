import { Breadcrumb } from './Breadcrumb'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { SearchCommand } from './SearchCommand'
import { NotificationBell } from './NotificationBell'
import { ThemeToggle } from './ThemeToggle'
import { UserMenu } from './UserMenu'

export function Topbar() {
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-border bg-background/70 px-6 backdrop-blur-xl">
      <div className="flex items-center gap-3">
        <WorkspaceSwitcher />
        <div className="h-4 w-px bg-border" />
        <Breadcrumb />
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-1.5">
        <SearchCommand />
        <NotificationBell />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  )
}
