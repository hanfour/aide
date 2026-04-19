'use client'
import { ChevronsUpDown, Check } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { trpc } from '@/lib/trpc/client'

export function WorkspaceSwitcher() {
  const { data: orgs } = trpc.organizations.list.useQuery()
  const current = orgs?.[0]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-accent/30 transition-colors">
          <div className="flex h-5 w-5 items-center justify-center rounded bg-primary text-[11px] font-semibold text-primary-foreground">
            {current?.name.charAt(0).toUpperCase() ?? 'a'}
          </div>
          <span className="max-w-[140px] truncate">{current?.name ?? 'No workspace'}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Workspaces
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {orgs?.map((o) => (
          <DropdownMenuItem key={o.id} className="cursor-pointer">
            <div className="mr-2 flex h-5 w-5 items-center justify-center rounded bg-primary text-[11px] font-semibold text-primary-foreground">
              {o.name.charAt(0).toUpperCase()}
            </div>
            <span className="flex-1 truncate">{o.name}</span>
            {o.id === current?.id && <Check className="h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
        {orgs?.length === 0 && (
          <DropdownMenuItem disabled>No organizations</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
