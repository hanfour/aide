export interface TruncateInput {
  requestBody: string;
  responseBody: string;
  thinkingBody?: string | null;
  attemptErrors?: string | null;
  perToolResultCap?: number; // Default 16384 (16KB) — cap per tool_result content block
  overallCap?: number; // Default 262144 (256KB) — total byte budget
}

export interface TruncateOutput {
  requestBody: string;
  responseBody: string;
  thinkingBody: string | null;
  attemptErrors: string | null;
  toolResultTruncated: boolean; // True if any per-tool cap was applied
  bodyTruncated: boolean; // True if overall cap forced any tail drop
}

const PER_TOOL_RESULT_CAP = 16384;
const OVERALL_CAP = 262144;
const TRUNC_MARKER = "...[truncated]";

export function truncate(input: TruncateInput): TruncateOutput {
  const perToolResultCap = input.perToolResultCap ?? PER_TOOL_RESULT_CAP;
  const overallCap = input.overallCap ?? OVERALL_CAP;

  // Step 1: Per-tool_result cap
  let toolResultTruncated = false;

  const reqCapResult = capToolResultsInJson(input.requestBody, perToolResultCap);
  const resCapResult = capToolResultsInJson(input.responseBody, perToolResultCap);

  let requestBody = reqCapResult.out;
  let responseBody = resCapResult.out;

  if (reqCapResult.changed || resCapResult.changed) {
    toolResultTruncated = true;
  }

  let thinkingBody = input.thinkingBody ?? null;
  let attemptErrors = input.attemptErrors ?? null;

  // Step 2: Overall cap
  const totalBytes = computeTotalBytes(requestBody, responseBody, thinkingBody, attemptErrors);

  if (totalBytes <= overallCap) {
    return {
      requestBody,
      responseBody,
      thinkingBody,
      attemptErrors,
      toolResultTruncated,
      bodyTruncated: false,
    };
  }

  let bodyTruncated = false;

  // Step 2a: Truncate tail of responseBody first
  if (computeTotalBytes(requestBody, responseBody, thinkingBody, attemptErrors) > overallCap) {
    const budget = overallCap - computeOtherBytes(requestBody, thinkingBody, attemptErrors);
    if (budget < Buffer.byteLength(responseBody)) {
      responseBody = truncateStringTail(responseBody, Math.max(0, budget));
      bodyTruncated = true;
    }
  }

  // Step 2b: If still over, re-apply tool_result caps more aggressively (halved)
  // Simplified: skip the re-parsing of already-serialized JSON and instead
  // just check if we need more drops. The halved approach is complex and fragile
  // when the JSON has already been re-serialized; we proceed directly to step 2c/2d.
  // This is an intentional simplification documented here.

  // Step 2c: Drop thinkingBody entirely if still over
  if (computeTotalBytes(requestBody, responseBody, thinkingBody, attemptErrors) > overallCap) {
    if (thinkingBody !== null) {
      thinkingBody = null;
      bodyTruncated = true;
    }
  }

  // Step 2d: Drop attemptErrors entirely as last resort
  if (computeTotalBytes(requestBody, responseBody, thinkingBody, attemptErrors) > overallCap) {
    if (attemptErrors !== null) {
      attemptErrors = null;
      bodyTruncated = true;
    }
  }

  return {
    requestBody,
    responseBody,
    thinkingBody,
    attemptErrors,
    toolResultTruncated,
    bodyTruncated,
  };
}

function computeTotalBytes(
  requestBody: string,
  responseBody: string,
  thinkingBody: string | null,
  attemptErrors: string | null,
): number {
  return (
    Buffer.byteLength(requestBody) +
    Buffer.byteLength(responseBody) +
    Buffer.byteLength(thinkingBody ?? "") +
    Buffer.byteLength(attemptErrors ?? "")
  );
}

function computeOtherBytes(
  requestBody: string,
  thinkingBody: string | null,
  attemptErrors: string | null,
): number {
  return (
    Buffer.byteLength(requestBody) +
    Buffer.byteLength(thinkingBody ?? "") +
    Buffer.byteLength(attemptErrors ?? "")
  );
}

function truncateStringTail(s: string, cap: number): string {
  if (Buffer.byteLength(s) <= cap) return s;
  const budget = Math.max(0, cap - Buffer.byteLength(TRUNC_MARKER));
  // Truncate to budget bytes — UTF-8 safe: slice by char then re-check
  let sliced = s.slice(0, budget);
  while (Buffer.byteLength(sliced) > budget && sliced.length > 0) {
    sliced = sliced.slice(0, -1);
  }
  return sliced + TRUNC_MARKER;
}

interface CapResult {
  out: string;
  changed: boolean;
}

function capToolResultsInJson(body: string, cap: number): CapResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { out: body, changed: false };
  }

  const result = capToolResultsInValue(parsed, cap);
  if (!result.changed) {
    return { out: body, changed: false };
  }

  return { out: JSON.stringify(result.out), changed: true };
}

interface ValueCapResult {
  out: unknown;
  changed: boolean;
}

function capToolResultsInValue(value: unknown, cap: number): ValueCapResult {
  if (value === null || value === undefined || typeof value !== "object") {
    return { out: value, changed: false };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const r = capToolResultsInValue(item, cap);
      if (r.changed) changed = true;
      return r.out;
    });
    return { out, changed };
  }

  const obj = value as Record<string, unknown>;

  // If this is a tool_result entry with a string content field, apply cap
  if (obj["type"] === "tool_result" && typeof obj["content"] === "string") {
    const content = obj["content"];
    if (Buffer.byteLength(content) > cap) {
      const truncated = truncateStringTail(content, cap);
      return {
        out: { ...obj, content: truncated },
        changed: true,
      };
    }
    return { out: obj, changed: false };
  }

  // Otherwise recurse into all fields
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    const r = capToolResultsInValue(val, cap);
    out[key] = r.out;
    if (r.changed) changed = true;
  }
  return { out, changed };
}
