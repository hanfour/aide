// Plan 5A Part 6 Task 6.10 — typed event union for the OpenAI
// Responses SSE protocol.
//
// Subset gated by design A6 (text + function-calling only).  The
// protocol uses named SSE events (`event: response.output_text.delta`
// etc.); the corresponding `data:` payload shapes are below. We keep
// the union narrow — exotic event types (`response.web_search_call.*`,
// `response.code_interpreter_call.*`, etc.) are filtered out at parse
// time, since translators don't model them.

import type { ResponsesUsage } from "../responsesTypes.js";

export interface ResponsesEventResponseCreated {
  type: "response.created";
  response: {
    id: string;
    model: string;
    created_at: number;
  };
}

export interface ResponsesEventOutputItemAdded {
  type: "response.output_item.added";
  output_index: number;
  item:
    | { type: "message"; id: string; role: "assistant" }
    | {
        type: "function_call";
        id: string;
        call_id: string;
        name: string;
        arguments?: string;
      };
}

export interface ResponsesEventOutputItemDone {
  type: "response.output_item.done";
  output_index: number;
}

export interface ResponsesEventContentPartAdded {
  type: "response.content_part.added";
  output_index: number;
  content_index: number;
  part: { type: "output_text"; text: "" };
}

export interface ResponsesEventOutputTextDelta {
  type: "response.output_text.delta";
  output_index: number;
  content_index: number;
  delta: string;
}

export interface ResponsesEventFunctionCallArgsDelta {
  type: "response.function_call_arguments.delta";
  output_index: number;
  delta: string;
}

export interface ResponsesEventCompleted {
  type: "response.completed";
  response: {
    id: string;
    status: "completed" | "incomplete" | "failed";
    incomplete_details?: { reason: string } | null;
    usage?: ResponsesUsage;
  };
}

export interface ResponsesEventError {
  type: "error";
  error: { kind: string; message: string };
}

export type ResponsesSSEEvent =
  | ResponsesEventResponseCreated
  | ResponsesEventOutputItemAdded
  | ResponsesEventOutputItemDone
  | ResponsesEventContentPartAdded
  | ResponsesEventOutputTextDelta
  | ResponsesEventFunctionCallArgsDelta
  | ResponsesEventCompleted
  | ResponsesEventError;
