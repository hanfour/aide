"use client";
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { trpc } from "./client";

// Don't retry 4xx errors — they're not transient (BAD_REQUEST,
// UNAUTHORIZED, FORBIDDEN, NOT_FOUND, TOO_MANY_REQUESTS, …). Without
// this, a 429 from the rate limiter sends react-query into 3 retries
// with exponential backoff, and the consuming page renders its
// "Loading…" placeholder for 7+ seconds before finally surfacing the
// error to the user.
function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null
      ? (error as { data?: { httpStatus?: number } }).data?.httpStatus
      : undefined;
  if (typeof status === "number" && status >= 400 && status < 500) return false;
  return failureCount < 2;
}

export function TrpcProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: shouldRetryQuery },
        },
      }),
  );
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          // same-origin — Next.js rewrite forwards to the internal API
          url: "/trpc",
        }),
      ],
    }),
  );
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
