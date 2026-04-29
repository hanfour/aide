import { z } from "zod";

// Plan 5A §9.4 — OpenAI Responses API request/response shape.  Subset
// supported by 5A: text + function-calling.  Decision A6 explicitly
// rejects file_search / code_interpreter / image / structured-outputs
// extensions with HTTP 400 unsupported_feature.
//
// Reference: https://platform.openai.com/docs/api-reference/responses

// ── Input items ──────────────────────────────────────────────────────────────

/** A `message` input item is the request-side analogue of Anthropic's
 *  user/assistant message: a role + ordered content blocks. */
export const ResponsesInputContentTextSchema = z.object({
  type: z.enum(["input_text", "output_text"]),
  text: z.string(),
});

export const ResponsesInputContentImageSchema = z.object({
  type: z.literal("input_image"),
  image_url: z.string(),
  detail: z.enum(["auto", "low", "high"]).optional(),
});

export const ResponsesInputContentSchema = z.union([
  ResponsesInputContentTextSchema,
  ResponsesInputContentImageSchema,
]);

export const ResponsesInputMessageSchema = z.object({
  type: z.literal("message").optional(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(ResponsesInputContentSchema)]),
});

/** Tool call output — the user's submission of a previous function-call's
 *  result.  Mirrors Anthropic's `tool_result` content block. */
export const ResponsesInputFunctionCallOutputSchema = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  output: z.string(),
});

/** Function-call output item from a previous turn (assistant-side echo).
 *  Used when the client replays history that includes a prior tool call.
 */
export const ResponsesInputFunctionCallSchema = z.object({
  type: z.literal("function_call"),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
});

export const ResponsesInputItemSchema = z.union([
  ResponsesInputMessageSchema,
  ResponsesInputFunctionCallSchema,
  ResponsesInputFunctionCallOutputSchema,
]);

// ── Tools ────────────────────────────────────────────────────────────────────

export const ResponsesToolFunctionSchema = z.object({
  type: z.literal("function"),
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.unknown()),
  strict: z.boolean().optional(),
});

export const ResponsesToolSchema = ResponsesToolFunctionSchema;

export const ResponsesToolChoiceAutoSchema = z.union([
  z.literal("auto"),
  z.literal("none"),
  z.literal("required"),
]);

export const ResponsesToolChoiceFunctionSchema = z.object({
  type: z.literal("function"),
  name: z.string(),
});

export const ResponsesToolChoiceSchema = z.union([
  ResponsesToolChoiceAutoSchema,
  ResponsesToolChoiceFunctionSchema,
]);

// ── Request ──────────────────────────────────────────────────────────────────

export const ResponsesRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(ResponsesInputItemSchema)]),
    instructions: z.string().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    tools: z.array(ResponsesToolSchema).optional(),
    tool_choice: ResponsesToolChoiceSchema.optional(),
    stream: z.boolean().optional(),
    /**
     * Per design A6 — client-supplied `previous_response_id` is allowed
     * (the gateway uses it for sticky scheduling in Part 7) but `store`
     * is rejected by `.strict()` below: any unknown key (including
     * `store`, `parallel_tool_calls`, `reasoning`, etc.) raises a zod
     * error so the route handler can return HTTP 400
     * `unsupported_feature` rather than silently dropping fields.
     */
    previous_response_id: z.string().optional(),
  })
  .strict();

export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;
export type ResponsesInputItem = z.infer<typeof ResponsesInputItemSchema>;
export type ResponsesInputMessage = z.infer<typeof ResponsesInputMessageSchema>;
export type ResponsesInputFunctionCall = z.infer<
  typeof ResponsesInputFunctionCallSchema
>;
export type ResponsesInputFunctionCallOutput = z.infer<
  typeof ResponsesInputFunctionCallOutputSchema
>;
export type ResponsesInputContent = z.infer<typeof ResponsesInputContentSchema>;
export type ResponsesTool = z.infer<typeof ResponsesToolSchema>;
export type ResponsesToolChoice = z.infer<typeof ResponsesToolChoiceSchema>;
