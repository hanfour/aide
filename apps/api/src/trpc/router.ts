import { router } from './procedures.js'
import { meRouter } from './routers/me.js'

export const appRouter = router({
  me: meRouter
})

export type AppRouter = typeof appRouter
