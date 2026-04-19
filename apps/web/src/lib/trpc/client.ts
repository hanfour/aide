'use client'
import { createTRPCReact } from '@trpc/react-query'
import type { AppRouter } from '@aide/api-types'

export const trpc = createTRPCReact<AppRouter>()
