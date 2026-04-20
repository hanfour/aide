export interface AccountStateUpdate {
  rateLimitedAt?: Date;
  rateLimitResetAt?: Date;
  overloadUntil?: Date;
  tempUnschedulableUntil?: Date;
  tempUnschedulableReason?: string;
  status?: "active" | "error" | "disabled";
  errorMessage?: string;
}

export type UpstreamError =
  | { status: number; retryAfter?: number; message?: string }
  | { kind: "connection"; message?: string }
  | { kind: "timeout"; message?: string };

export type FailoverAction =
  | { kind: "switch_account"; stateUpdate?: AccountStateUpdate; reason: string }
  | {
      kind: "retry_same_account";
      backoffMs: number;
      stateUpdate?: AccountStateUpdate;
    }
  | {
      kind: "fatal";
      statusCode: number;
      reason: string;
      stateUpdate?: AccountStateUpdate;
    };
