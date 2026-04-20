import { eq } from "drizzle-orm";
import { upstreamAccounts } from "@aide/db";
import type { Database } from "@aide/db";
import {
  classifyUpstreamError,
  type AccountStateUpdate,
  type UpstreamError,
} from "@aide/gateway-core";
import { selectAccounts, type SelectedAccount } from "./selectAccount.js";

const MAX_SAME_ACCOUNT_RETRIES = 3;

export class AllUpstreamsFailed extends Error {
  constructor(public readonly attemptedIds: string[]) {
    super(`All upstreams failed after ${attemptedIds.length} attempts`);
    this.name = "AllUpstreamsFailed";
  }
}

export class FatalUpstreamError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly reason: string,
    public readonly cause?: Error,
  ) {
    super(`fatal upstream: ${reason} (${statusCode})`);
    this.name = "FatalUpstreamError";
  }
}

export interface RunFailoverInput<T> {
  db: Database;
  orgId: string;
  teamId: string | null;
  maxSwitches: number;
  attempt: (account: SelectedAccount) => Promise<T>;
  /** Inject for tests so we can fast-forward backoffs. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export async function runFailover<T>(input: RunFailoverInput<T>): Promise<T> {
  const sleep = input.sleep ?? defaultSleep;
  const failed: string[] = [];

  for (let switchCount = 0; switchCount < input.maxSwitches; switchCount++) {
    const candidates = await selectAccounts(input.db, {
      orgId: input.orgId,
      teamId: input.teamId,
      excludeIds: failed,
      limit: 1,
    });

    if (candidates.length === 0) {
      throw new AllUpstreamsFailed(failed);
    }

    const account = candidates[0]!;
    let exhaustedSameAccount = false;

    for (let retry = 0; retry <= MAX_SAME_ACCOUNT_RETRIES; retry++) {
      try {
        return await input.attempt(account);
      } catch (rawErr) {
        const upstreamErr = toUpstreamError(rawErr);
        const action = classifyUpstreamError(upstreamErr);

        if (action.kind === "fatal") {
          if (action.stateUpdate) {
            await applyAccountStateUpdate(
              input.db,
              account.id,
              action.stateUpdate,
            );
          }
          throw new FatalUpstreamError(
            action.statusCode,
            action.reason,
            rawErr instanceof Error ? rawErr : undefined,
          );
        }

        if (action.kind === "retry_same_account") {
          if (retry === MAX_SAME_ACCOUNT_RETRIES) {
            exhaustedSameAccount = true;
            break;
          }
          await sleep(action.backoffMs);
          continue;
        }

        // switch_account
        if (action.stateUpdate) {
          await applyAccountStateUpdate(
            input.db,
            account.id,
            action.stateUpdate,
          );
        }
        failed.push(account.id);
        break;
      }
    }

    if (exhaustedSameAccount) {
      // 3 retries on connection/timeout exhausted — try a different account
      failed.push(account.id);
    }
  }

  throw new AllUpstreamsFailed(failed);
}

export async function applyAccountStateUpdate(
  db: Database,
  accountId: string,
  update: AccountStateUpdate,
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (update.rateLimitedAt !== undefined) set.rateLimitedAt = update.rateLimitedAt;
  if (update.rateLimitResetAt !== undefined) set.rateLimitResetAt = update.rateLimitResetAt;
  if (update.overloadUntil !== undefined) set.overloadUntil = update.overloadUntil;
  if (update.tempUnschedulableUntil !== undefined) set.tempUnschedulableUntil = update.tempUnschedulableUntil;
  if (update.tempUnschedulableReason !== undefined) set.tempUnschedulableReason = update.tempUnschedulableReason;
  if (update.status !== undefined) set.status = update.status;
  if (update.errorMessage !== undefined) set.errorMessage = update.errorMessage;
  if (Object.keys(set).length === 0) return;
  set.updatedAt = new Date();
  await db
    .update(upstreamAccounts)
    .set(set)
    .where(eq(upstreamAccounts.id, accountId));
}

/** Coerces a thrown value into the discriminated UpstreamError shape. */
function toUpstreamError(rawErr: unknown): UpstreamError {
  if (rawErr && typeof rawErr === "object") {
    const e = rawErr as Record<string, unknown>;
    if (typeof e.status === "number") {
      return {
        status: e.status,
        retryAfter: typeof e.retryAfter === "number" ? e.retryAfter : undefined,
        message: typeof e.message === "string" ? e.message : undefined,
      };
    }
    if (
      e.code === "ETIMEDOUT" ||
      e.code === "UND_ERR_HEADERS_TIMEOUT" ||
      e.code === "UND_ERR_BODY_TIMEOUT"
    ) {
      return {
        kind: "timeout",
        message: typeof e.message === "string" ? e.message : undefined,
      };
    }
    if (
      e.code === "ECONNREFUSED" ||
      e.code === "ECONNRESET" ||
      e.code === "EPIPE" ||
      e.code === "UND_ERR_SOCKET" ||
      e.code === "UND_ERR_CONNECT_TIMEOUT"
    ) {
      return {
        kind: "connection",
        message: typeof e.message === "string" ? e.message : undefined,
      };
    }
  }
  // Last resort: synthetic 500
  return {
    status: 500,
    message: rawErr instanceof Error ? rawErr.message : String(rawErr),
  };
}
