'use client'
import { TrpcProvider } from '@/lib/trpc/Provider'
export function Providers({ children }: { children: React.ReactNode }) {
  return <TrpcProvider>{children}</TrpcProvider>
}
