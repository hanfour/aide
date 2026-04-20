// Single source of truth for Redis key shapes. ioredis client (Task 4.1) prepends
// `aide:gw:` via keyPrefix; these helpers return the suffix only.
// All shapes match design Section 4.1.
export const keys = {
  slots: (scope: "user" | "account", id: string) => `slots:${scope}:${id}`,
  wait: (userId: string) => `wait:user:${userId}`,
  idem: (requestId: string) => `idem:${requestId}`,
  sticky: (orgId: string, sessionId: string) => `sticky:${orgId}:${sessionId}`,
  state: (accountId: string) => `state:account:${accountId}`,
  oauthRefresh: (accountId: string) => `oauth-refresh:${accountId}`,
} as const;
