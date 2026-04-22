export interface UsageRow {
  requestId: string;
  requestedModel: string;
  inputTokens: number;
  cacheReadTokens: number;
}

export interface BodyRow {
  requestId: string;
  stopReason: string | null;
  clientUserAgent: string | null;
  clientSessionId: string | null;
  requestParams: unknown;
  responseBody: unknown;
  requestBody: unknown;
}

export interface Evidence {
  requestId?: string;
  quote: string;
  offset: number;
}

export interface SignalResult {
  hit: boolean;
  value?: number;
  evidence: Evidence[];
}

export interface KeywordInput {
  body: string;
  terms: string[];
  caseSensitive?: boolean;
  requestId?: string;
}

export interface ThresholdInput {
  metricValue: number;
  gte?: number;
  lte?: number;
  between?: readonly [number, number];
}
