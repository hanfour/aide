import { TRPCError } from '@trpc/server'

export class ServiceError extends Error {
  constructor(
    public code: 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST' | 'FORBIDDEN',
    message: string
  ) {
    super(message)
  }
}

export function mapServiceError(err: unknown): TRPCError {
  if (err instanceof ServiceError) {
    return new TRPCError({ code: err.code, message: err.message })
  }
  if (err instanceof TRPCError) return err
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: err })
}
