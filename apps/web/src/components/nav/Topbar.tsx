import { UserMenu } from './UserMenu'

export function Topbar({ title }: { title: string }) {
  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-card px-6">
      <h1 className="text-sm font-semibold">{title}</h1>
      <div className="flex items-center gap-3">
        <UserMenu />
      </div>
    </header>
  )
}
