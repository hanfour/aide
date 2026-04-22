import type { Rubric } from "../rubric/schema.js";
import type { Report } from "../engine/types.js";

export interface Snippet {
  requestId: string;
  clientSessionId: string | null;
  capturedAt?: string; // ISO string; optional if caller doesn't have it
  reason: "refusal" | "thinking" | "session_first" | "session_last" | "tool_use" | "random";
  requestExcerpt: string; // Up to 1024 chars
  responseExcerpt: string; // Up to 1024 chars
}

export interface LlmPrompt {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface BuildPromptInput {
  rubric: Rubric;
  ruleBasedReport: Report;
  snippets: Snippet[];
}
